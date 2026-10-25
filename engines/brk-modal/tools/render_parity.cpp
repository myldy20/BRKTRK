#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr std::uint32_t kSampleRate = 48000;
constexpr std::uint32_t kBlock = 128;
constexpr double kDurationSeconds = 3.0;
constexpr double kReleaseSeconds = 0.8;
constexpr double kPi = 3.14159265358979323846;

struct Case {
    std::string id;
    std::string description;
    brk::modal::Patch patch;
    std::int16_t key = 60;
    float velocity = 1.0F;
};

struct Metrics {
    double peak = 0.0;
    double transient_rms = 0.0;
    double body_rms = 0.0;
    double tail_rms = 0.0;
    double spectral_centroid_hz = 0.0;
    double decay_t30_seconds = 0.0;
    double stereo_difference_rms = 0.0;
};

void write_u16(std::ofstream& out, std::uint16_t value) {
    const std::array<char, 2> bytes = {
        static_cast<char>(value & 0xffU), static_cast<char>((value >> 8U) & 0xffU)};
    out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

void write_u32(std::ofstream& out, std::uint32_t value) {
    const std::array<char, 4> bytes = {
        static_cast<char>(value & 0xffU), static_cast<char>((value >> 8U) & 0xffU),
        static_cast<char>((value >> 16U) & 0xffU), static_cast<char>((value >> 24U) & 0xffU)};
    out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

void write_wav(const std::filesystem::path& path, const std::vector<float>& left, const std::vector<float>& right) {
    if (left.size() != right.size()) throw std::runtime_error("channel size mismatch");
    std::ofstream out(path, std::ios::binary);
    if (!out) throw std::runtime_error("cannot create wav: " + path.string());

    const std::uint32_t data_bytes = static_cast<std::uint32_t>(left.size() * 4U);
    out.write("RIFF", 4);
    write_u32(out, 36U + data_bytes);
    out.write("WAVEfmt ", 8);
    write_u32(out, 16U);
    write_u16(out, 1U);
    write_u16(out, 2U);
    write_u32(out, kSampleRate);
    write_u32(out, kSampleRate * 4U);
    write_u16(out, 4U);
    write_u16(out, 16U);
    out.write("data", 4);
    write_u32(out, data_bytes);

    for (std::size_t i = 0; i < left.size(); ++i) {
        const auto quantize = [](float sample) {
            const float bounded = std::max(-1.0F, std::min(1.0F, sample));
            return static_cast<std::int16_t>(std::lrint(bounded * 32767.0F));
        };
        write_u16(out, static_cast<std::uint16_t>(quantize(left[i])));
        write_u16(out, static_cast<std::uint16_t>(quantize(right[i])));
    }
}

double rms_window(const std::vector<float>& mono, double start_seconds, double end_seconds) {
    const std::size_t begin = std::min<std::size_t>(mono.size(), static_cast<std::size_t>(start_seconds * kSampleRate));
    const std::size_t end = std::min<std::size_t>(mono.size(), static_cast<std::size_t>(end_seconds * kSampleRate));
    if (end <= begin) return 0.0;
    long double energy = 0.0;
    for (std::size_t i = begin; i < end; ++i) energy += static_cast<long double>(mono[i]) * mono[i];
    return std::sqrt(static_cast<double>(energy / static_cast<long double>(end - begin)));
}

void fft(std::vector<std::complex<double>>& values) {
    const std::size_t n = values.size();
    for (std::size_t i = 1, j = 0; i < n; ++i) {
        std::size_t bit = n >> 1U;
        while ((j & bit) != 0U) {
            j ^= bit;
            bit >>= 1U;
        }
        j ^= bit;
        if (i < j) std::swap(values[i], values[j]);
    }
    for (std::size_t length = 2; length <= n; length <<= 1U) {
        const double angle = -2.0 * kPi / static_cast<double>(length);
        const std::complex<double> step(std::cos(angle), std::sin(angle));
        for (std::size_t offset = 0; offset < n; offset += length) {
            std::complex<double> w(1.0, 0.0);
            for (std::size_t i = 0; i < length / 2U; ++i) {
                const auto even = values[offset + i];
                const auto odd = values[offset + i + length / 2U] * w;
                values[offset + i] = even + odd;
                values[offset + i + length / 2U] = even - odd;
                w *= step;
            }
        }
    }
}

double spectral_centroid(const std::vector<float>& mono) {
    constexpr std::size_t fft_size = 16384;
    std::vector<std::complex<double>> spectrum(fft_size);
    const std::size_t start = std::min<std::size_t>(mono.size(), static_cast<std::size_t>(0.005 * kSampleRate));
    for (std::size_t i = 0; i < fft_size; ++i) {
        const double sample = start + i < mono.size() ? mono[start + i] : 0.0;
        const double window = 0.5 - 0.5 * std::cos(2.0 * kPi * static_cast<double>(i) / static_cast<double>(fft_size - 1U));
        spectrum[i] = sample * window;
    }
    fft(spectrum);
    long double weighted = 0.0;
    long double total = 0.0;
    for (std::size_t bin = 1; bin < fft_size / 2U; ++bin) {
        const double magnitude = std::abs(spectrum[bin]);
        const double frequency = static_cast<double>(bin) * kSampleRate / fft_size;
        weighted += static_cast<long double>(frequency * magnitude);
        total += magnitude;
    }
    return total > 0.0 ? static_cast<double>(weighted / total) : 0.0;
}

double decay_t30(const std::vector<float>& mono) {
    const std::size_t release = std::min<std::size_t>(mono.size(), static_cast<std::size_t>(kReleaseSeconds * kSampleRate));
    if (release + 2U >= mono.size()) return 0.0;
    std::vector<long double> integrated(mono.size() - release + 1U, 0.0);
    for (std::size_t i = mono.size(); i-- > release;) {
        const long double sample = mono[i];
        integrated[i - release] = integrated[i - release + 1U] + sample * sample;
    }
    const long double reference = integrated.front();
    if (reference <= std::numeric_limits<long double>::epsilon()) return 0.0;

    auto crossing = [&](double db) -> double {
        const long double target = reference * std::pow(10.0L, static_cast<long double>(db) / 10.0L);
        for (std::size_t i = 0; i + 1U < integrated.size(); ++i) {
            if (integrated[i] <= target) return static_cast<double>(i) / kSampleRate;
        }
        return 0.0;
    };

    const double t5 = crossing(-5.0);
    const double t35 = crossing(-35.0);
    return t35 > t5 ? 2.0 * (t35 - t5) : 0.0;
}

Metrics analyze(const std::vector<float>& left, const std::vector<float>& right) {
    std::vector<float> mono(left.size());
    long double stereo_energy = 0.0;
    double peak = 0.0;
    for (std::size_t i = 0; i < left.size(); ++i) {
        mono[i] = 0.5F * (left[i] + right[i]);
        peak = std::max(peak, static_cast<double>(std::max(std::abs(left[i]), std::abs(right[i]))));
        const long double difference = static_cast<long double>(left[i]) - right[i];
        stereo_energy += difference * difference;
    }
    Metrics metrics;
    metrics.peak = peak;
    metrics.transient_rms = rms_window(mono, 0.0, 0.05);
    metrics.body_rms = rms_window(mono, 0.05, 0.50);
    metrics.tail_rms = rms_window(mono, 1.5, 2.5);
    metrics.spectral_centroid_hz = spectral_centroid(mono);
    metrics.decay_t30_seconds = decay_t30(mono);
    metrics.stereo_difference_rms = left.empty() ? 0.0 : std::sqrt(static_cast<double>(stereo_energy / left.size()));
    return metrics;
}

brk::modal::Patch single_model(brk::modal::Model model) {
    brk::modal::Patch patch;
    patch.resonator_a.model = model;
    patch.resonator_a.partials = 64;
    patch.resonator_a.decay_seconds = 1.8F;
    patch.resonator_a.release_scale = 0.75F;
    patch.resonator_a.material = 0.0F;
    patch.resonator_a.tone = 0.0F;
    patch.resonator_a.hit_position = 0.26F;
    patch.resonator_a.inharmonicity = 0.0001F;
    patch.resonator_b.enabled = false;
    patch.exciter.mallet_resonator = 0.8F;
    patch.exciter.mallet_hardness_hz = 600.0F;
    patch.exciter.noise_resonator = 0.0F;
    patch.stereo_mode = brk::modal::StereoMode::Comb;
    patch.stereo_width = 1.0F;
    patch.polyphony = 4;
    if (model == brk::modal::Model::Beam) patch.resonator_a.ratio = 2.0F;
    if (model == brk::modal::Model::Membrane || model == brk::modal::Model::Plate) patch.resonator_a.ratio = 0.78F;
    return patch;
}

std::vector<Case> build_cases(bool smoke) {
    std::vector<Case> cases;
    const std::array<std::pair<brk::modal::Model, const char*>, 9> models = {{
        {brk::modal::Model::String, "string"}, {brk::modal::Model::Beam, "beam"},
        {brk::modal::Model::Squared, "squared"}, {brk::modal::Model::Membrane, "membrane"},
        {brk::modal::Model::Plate, "plate"}, {brk::modal::Model::Drumhead, "drumhead"},
        {brk::modal::Model::Marimba, "marimba"}, {brk::modal::Model::OpenTube, "open_tube"},
        {brk::modal::Model::ClosedTube, "closed_tube"},
    }};
    for (const auto& [model, name] : models) {
        cases.push_back({name, std::string("single ") + name + " resonator", single_model(model), 60, 1.0F});
        if (smoke && cases.size() == 2U) return cases;
    }

    auto parallel = single_model(brk::modal::Model::Plate);
    parallel.resonator_b.enabled = true;
    parallel.resonator_b.model = brk::modal::Model::Beam;
    parallel.resonator_b.ratio = 2.0F;
    parallel.resonator_b.partials = 64;
    parallel.resonator_b.decay_seconds = 1.2F;
    parallel.parallel_mix = 0.42F;
    cases.push_back({"dual_parallel", "plate plus beam in parallel", parallel, 60, 1.0F});

    auto serial = parallel;
    serial.coupling = brk::modal::Coupling::Serial;
    serial.coupling_split = 0.04F;
    cases.push_back({"dual_serial", "plate into beam with modal frequency splitting", serial, 60, 1.0F});

    auto low = single_model(brk::modal::Model::String);
    cases.push_back({"low_note", "string C2", low, 36, 1.0F});
    cases.push_back({"high_note", "string C6", low, 84, 1.0F});
    cases.push_back({"soft_velocity", "plate at velocity 0.25", single_model(brk::modal::Model::Plate), 60, 0.25F});
    cases.push_back({"hard_velocity", "plate at velocity 1.0", single_model(brk::modal::Model::Plate), 60, 1.0F});
    return cases;
}

void render_case(const Case& test_case, std::vector<float>& left, std::vector<float>& right) {
    const std::uint32_t total_frames = static_cast<std::uint32_t>(kDurationSeconds * kSampleRate);
    left.assign(total_frames, 0.0F);
    right.assign(total_frames, 0.0F);
    brk::modal::Engine engine;
    if (!engine.prepare(kSampleRate, kBlock, 0x504152495459ULL)) throw std::runtime_error("engine prepare failed");
    engine.set_patch(test_case.patch);
    engine.note_on({1U, test_case.key, test_case.velocity, 0.0F});

    std::array<float, kBlock> block_left{};
    std::array<float, kBlock> block_right{};
    const std::uint32_t release_frame = static_cast<std::uint32_t>(kReleaseSeconds * kSampleRate);
    bool released = false;
    for (std::uint32_t offset = 0; offset < total_frames; offset += kBlock) {
        if (!released && offset >= release_frame) {
            engine.note_off(1U);
            released = true;
        }
        const std::uint32_t count = std::min(kBlock, total_frames - offset);
        engine.process(block_left.data(), block_right.data(), count);
        std::copy_n(block_left.begin(), count, left.begin() + offset);
        std::copy_n(block_right.begin(), count, right.begin() + offset);
    }
}

} // namespace

int main(int argc, char** argv) {
    try {
        const std::filesystem::path root = argc > 1 ? argv[1] : "parity-output";
        const bool smoke = argc > 2 && std::string(argv[2]) == "--smoke";
        const auto candidate_dir = root / "candidate";
        std::filesystem::create_directories(candidate_dir);

        std::ofstream cases_csv(root / "cases.csv");
        std::ofstream metrics_csv(root / "metrics.csv");
        if (!cases_csv || !metrics_csv) throw std::runtime_error("cannot create parity CSV files");
        cases_csv << "case_id,description,key,velocity,reference_filename,candidate_filename\n";
        metrics_csv << "case_id,peak,transient_rms,body_rms,tail_rms,spectral_centroid_hz,decay_t30_seconds,stereo_difference_rms\n";
        metrics_csv << std::setprecision(10);

        std::vector<float> left;
        std::vector<float> right;
        for (const Case& test_case : build_cases(smoke)) {
            render_case(test_case, left, right);
            const std::string filename = test_case.id + ".wav";
            write_wav(candidate_dir / filename, left, right);
            const Metrics metrics = analyze(left, right);
            cases_csv << test_case.id << ",\"" << test_case.description << "\"," << test_case.key << ','
                      << test_case.velocity << ',' << filename << ',' << filename << '\n';
            metrics_csv << test_case.id << ',' << metrics.peak << ',' << metrics.transient_rms << ','
                        << metrics.body_rms << ',' << metrics.tail_rms << ',' << metrics.spectral_centroid_hz << ','
                        << metrics.decay_t30_seconds << ',' << metrics.stereo_difference_rms << '\n';
            std::cout << test_case.id << ": peak=" << metrics.peak
                      << " centroid=" << metrics.spectral_centroid_hz
                      << "Hz t30=" << metrics.decay_t30_seconds << "s\n";
        }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "brk_modal_parity: " << error.what() << '\n';
        return 1;
    }
}
