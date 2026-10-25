constexpr std::array<float, kMaxPartials> kDrumheadRatios = {
    1.0F, 1.5933405F, 2.1355488F, 2.2954173F, 2.6530664F, 2.9172955F, 3.1554648F, 3.5001475F,
    3.5984847F, 3.6474512F, 4.0589319F, 4.1317382F, 4.2304391F, 4.6010445F, 4.6100516F, 4.8318853F,
    4.9032806F, 5.1307689F, 5.4121184F, 5.5403985F, 5.6508424F, 5.9765402F, 6.1526096F, 6.1631365F,
    6.2087321F, 6.5286121F, 6.7462133F, 6.8489916F, 7.0707082F, 7.3252573F, 7.4682422F, 7.5145010F,
    7.6045361F, 7.8925200F, 8.0710278F, 8.1568737F, 8.4500055F, 8.6604757F, 8.7810926F, 8.8204470F,
    8.9992142F, 9.2388401F, 9.3905897F, 9.4643393F, 9.8078146F, 9.9878426F, 10.0922546F, 10.1265020F,
    10.3687057F, 10.5747137F, 10.7068750F, 10.7715387F, 11.1526394F, 11.3102121F, 11.4023123F, 11.7227583F,
    11.9038239F, 12.0209761F, 12.4889412F, 12.6291933F, 13.0665588F, 13.2282848F, 13.8193149F, 14.4031601F,
};

constexpr std::array<float, 21> kMarimbaRatios = {
    1.0F, 3.9393939F, 10.5757576F, 19.0F, 26.7575758F, 36.9393939F, 49.1818182F,
    63.1818182F, 78.9090909F, 96.3939394F, 115.6363636F, 136.6060606F, 159.3636364F,
    183.8181818F, 210.0606061F, 238.0303030F, 267.7575758F, 299.2424242F,
    442.6363636F, 568.5454545F, 614.0F,
};

// GPL-3.0 upstream tables from RipplerX 1.5.18 / src/dsp/Models.cpp.
constexpr std::array<float, kMaxPartials> kMarimba2Ratios = {
    1.0F, 1.9203267F, 2.3141718F, 4.7078641F, 6.8738849F, 7.4069864F, 9.1004588F, 13.2570607F,
    14.6379493F, 17.3075964F, 19.6505429F, 20.7327519F, 24.5989214F, 25.4342475F, 26.0934865F, 29.3778996F,
    31.0350720F, 32.9095141F, 34.4495073F, 35.8019502F, 37.9935403F, 40.5794425F, 44.5049446F, 45.1941151F,
    47.3205349F, 49.1412699F, 53.4807201F, 55.9368124F, 57.0308030F, 58.2150132F, 62.3498244F, 65.8846231F,
    66.6255903F, 67.6971853F, 69.3962832F, 76.0497035F, 77.5288782F, 77.8599306F, 78.1459793F, 79.9581169F,
    84.1006764F, 86.7082313F, 87.3871063F, 89.6768763F, 90.9155365F, 93.6067302F, 96.2866729F, 96.9176785F,
    98.3304092F, 99.5007149F, 99.7700996F, 101.4332158F, 106.6447168F, 107.4970254F, 108.1359915F, 109.3725289F,
    110.4233204F, 111.6513665F, 113.2042027F, 114.7177670F, 116.7089637F, 118.8317747F, 119.1141085F, 120.0194874F,
};

constexpr std::array<float, kMaxPartials> kBellRatios = {
    1.0F, 1.0036779F, 1.8972672F, 1.9079713F, 2.3187706F, 2.3328522F, 2.8855740F, 2.8862774F,
    3.3312111F, 3.4251081F, 3.6896036F, 3.6899187F, 3.8864386F, 3.8907319F, 3.9648326F, 4.0014507F,
    4.2371895F, 4.2483918F, 4.8357022F, 5.1896842F, 5.2525093F, 5.2548172F, 5.6842186F, 5.6858744F,
    5.7392849F, 5.7400835F, 5.7793685F, 5.7840355F, 5.8637849F, 5.9107480F, 6.4238259F, 6.4503920F,
    6.5008206F, 6.5075976F, 6.7170855F, 6.7383032F, 6.8699978F, 7.2137592F, 7.7456224F, 7.7547806F,
    7.8062862F, 7.9292988F, 7.9414609F, 7.9606565F, 7.9622683F, 8.1192761F, 8.1776687F, 8.4181991F,
    8.4294820F, 8.7884827F, 8.7992527F, 8.9029966F, 8.9185288F, 8.9338413F, 9.1444062F, 9.1611840F,
    9.1740787F, 9.1795736F, 9.3186314F, 9.3341637F, 9.8958898F, 9.9076855F, 10.0226390F, 10.0296725F,
};

constexpr std::array<float, kMaxPartials> kMarimba2Gains = {
    0.96623F, 0.859578F, 1.0F, 0.788921F, 0.722356F, 0.828411F, 0.804952F, 0.321144F,
    0.716796F, 0.634043F, 0.356832F, 0.758356F, 0.627535F, 0.522109F, 0.41653F, 0.399465F,
    0.639828F, 0.478843F, 0.395868F, 0.589925F, 0.789059F, 0.525307F, 0.814867F, 0.641971F,
    0.554683F, 0.417749F, 0.288577F, 0.80181F, 0.706824F, 0.268298F, 0.461017F, 0.598288F,
    0.769713F, 0.388368F, 0.510933F, 0.561361F, 0.495144F, 0.562978F, 0.155653F, 0.814671F,
    0.540099F, 0.636206F, 0.263332F, 0.324908F, 0.0159624F, 0.409779F, 0.849463F, 0.390377F,
    0.807923F, 0.195733F, 0.368285F, 0.133785F, 0.315076F, 0.561451F, 0.424994F, 0.815392F,
    0.805216F, 0.274915F, 0.7907F, 0.151032F, 0.295099F, 0.70326F, 0.319596F, 0.591565F,
};

constexpr std::array<float, kMaxPartials> kBellGains = {
    0.925507F, 0.59752F, 0.0965671F, 0.45412F, 0.989773F, 0.593498F, 0.512541F, 0.124241F,
    0.705411F, 0.292396F, 0.673399F, 0.302181F, 0.026234F, 0.286249F, 0.556267F, 1.0F,
    0.250426F, 0.107711F, 0.427299F, 0.336295F, 0.616257F, 0.21442F, 0.0845294F, 0.231363F,
    0.522724F, 0.559114F, 0.34847F, 0.854197F, 0.835576F, 0.735036F, 0.288494F, 0.117122F,
    0.409686F, 0.363575F, 0.484943F, 0.170862F, 0.420531F, 0.164793F, 0.233847F, 0.861232F,
    0.214037F, 0.283462F, 0.173153F, 0.876122F, 0.607809F, 0.294745F, 0.143142F, 0.332009F,
    0.491878F, 0.626104F, 0.384312F, 0.527985F, 0.201821F, 0.297983F, 0.212535F, 0.367379F,
    0.365935F, 0.558277F, 0.50738F, 0.14265F, 0.806237F, 0.255278F, 0.252357F, 0.117637F,
};

std::array<float, kMaxPartials> build_djembe_ratios(float base_frequency, float ratio_control) noexcept {
    std::array<float, kMaxPartials> result{};
    const float frequency = std::max(1.0F, base_frequency);
    const float ratio = clampf(ratio_control, 0.1F, 10.0F);
    for (std::size_t i = 0; i < kMaxPartials; ++i) {
        result[i] = 1.0F + (200.0F * static_cast<float>(i) * ratio) / frequency;
    }
    return result;
}

std::array<float, kMaxPartials> build_ratios(Model model, float ratio_control) noexcept {
    std::array<float, kMaxPartials> result{};
    const float ratio = clampf(ratio_control, 0.1F, 10.0F);

    if (model == Model::String || model == Model::OpenTube) {
        for (std::size_t i = 0; i < kMaxPartials; ++i) result[i] = static_cast<float>(i + 1U);
    } else if (model == Model::ClosedTube) {
        for (std::size_t i = 0; i < kMaxPartials; ++i) result[i] = static_cast<float>(2U * i + 1U);
    } else if (model == Model::Squared) {
        for (std::size_t i = 0; i < kMaxPartials; ++i) {
            const float k = static_cast<float>(i + 1U);
            result[i] = k * k;
        }
    } else if (model == Model::Beam) {
        std::size_t index = 0;
        for (std::size_t m = 1; m <= 8U; ++m) {
            for (std::size_t n = 1; n <= 8U; ++n) {
                (void)n;
                const float beta = index == 0U ? 1.50561873F
                    : (index == 1U ? 2.49975267F : static_cast<float>(index) + 1.5F);
                result[index] = std::sqrt(std::pow(static_cast<float>(m), 4.0F) + std::pow(ratio * beta, 4.0F));
                ++index;
            }
        }
        const float first = result[0];
        for (float& value : result) value /= first;
    } else if (model == Model::Membrane || model == Model::Plate) {
        std::size_t index = 0;
        for (std::size_t m = 1; m <= 8U; ++m) {
            for (std::size_t n = 1; n <= 8U; ++n) {
                const float base = static_cast<float>(m * m) + std::pow(ratio * static_cast<float>(n), 2.0F);
                result[index++] = model == Model::Membrane ? std::sqrt(base) : base;
            }
        }
        const float first = result[0];
        for (float& value : result) value /= first;
    } else if (model == Model::Drumhead) {
        result = kDrumheadRatios;
    } else if (model == Model::Marimba) {
        result.fill(100000.0F);
        for (std::size_t i = 0; i < kMarimbaRatios.size(); ++i) result[i] = kMarimbaRatios[i];
    } else if (model == Model::Marimba2) {
        result = kMarimba2Ratios;
    } else if (model == Model::Bell) {
        result = kBellRatios;
    } else if (model == Model::Djembe) {
        result = build_djembe_ratios(70.0F, ratio);
    }

    return result;
}

std::array<float, kMaxPartials> build_gains(Model model) noexcept {
    if (model == Model::Marimba2) return kMarimba2Gains;
    if (model == Model::Bell) return kBellGains;
    std::array<float, kMaxPartials> gains{};
    gains.fill(1.0F);
    return gains;
}

float reference_shift_ratio(float fa, float fb, float split, float base_frequency) noexcept {
    const float avg = 0.5F * (fa + fb);
    const float coupling = split + std::cos(avg) / 5.0F;
    const float w = avg + std::sqrt(std::pow(0.5F * (fa - fb), 2.0F) + std::pow(coupling / 2.5F, 2.0F));
    return std::abs(std::max(fa, fb) - w) / std::max(1.0F, base_frequency);
}

float clamp_shifted_ratio(float original_ratio, float shifted_ratio, float pitch, float max_cents) noexcept {
    const float original = original_ratio * pitch;
    const float shifted = std::max(1.0e-5F, shifted_ratio * pitch);
    if (max_cents <= 0.0F) return shifted / std::max(1.0e-5F, pitch);
    const float delta = clampf(cents_between(shifted, original), -max_cents, max_cents);
    return std::max(1.0e-5F, original * ratio_from_cents(delta) / std::max(1.0e-5F, pitch));
}

void apply_shift_pair(
    float& a_ratio,
    float& b_ratio,
    float a_pitch,
    float b_pitch,
    float shift_ratio,
    float max_cents) noexcept {

    const float original_a = a_ratio;
    const float original_b = b_ratio;
    const float fa_ratio = original_a * a_pitch;
    const float fb_ratio = original_b * b_pitch;
    float shifted_a = fa_ratio;
    float shifted_b = fb_ratio;
    if (fa_ratio > fb_ratio) {
        shifted_a += shift_ratio;
        shifted_b -= shift_ratio;
    } else {
        shifted_a -= shift_ratio;
        shifted_b += shift_ratio;
    }

    a_ratio = clamp_shifted_ratio(original_a, shifted_a / std::max(1.0e-5F, a_pitch), a_pitch, max_cents);
    b_ratio = clamp_shifted_ratio(original_b, shifted_b / std::max(1.0e-5F, b_pitch), b_pitch, max_cents);
}

void apply_serial_frequency_split(
    std::array<float, kMaxPartials>& a,
    std::array<float, kMaxPartials>& b,
    float base_frequency,
    const Patch& patch) noexcept {

    const float a_pitch = pitch_factor(patch.resonator_a);
    const float b_pitch = pitch_factor(patch.resonator_b);
    const float split = clampf(patch.coupling_split, 0.0001F, 1.0F) * 100.0F;
    const float max_cents = clampf(patch.max_coupling_detune_cents, 0.0F, 200.0F);

    if (patch.coupling_profile == CouplingProfile::Stable) {
        std::array<bool, kMaxPartials> used_b{};
        const std::size_t a_count = std::max<std::size_t>(1U, patch.resonator_a.partials);
        const std::size_t b_count = std::max<std::size_t>(1U, patch.resonator_b.partials);
        for (std::size_t i = 0; i < std::min(a_count, kMaxPartials); ++i) {
            const float fa_ratio = a[i] * a_pitch;
            if (fa_ratio >= 10000.0F) continue;
            std::size_t best = kMaxPartials;
            float best_distance = std::numeric_limits<float>::max();
            for (std::size_t j = 0; j < std::min(b_count, kMaxPartials); ++j) {
                if (used_b[j]) continue;
                const float fb_ratio = b[j] * b_pitch;
                if (fb_ratio >= 10000.0F) continue;
                const float distance = std::abs(fa_ratio - fb_ratio);
                if (distance <= 4.0F && distance < best_distance) {
                    best = j;
                    best_distance = distance;
                }
            }
            if (best == kMaxPartials) continue;
            used_b[best] = true;
            const float fa = fa_ratio * base_frequency;
            const float fb = b[best] * b_pitch * base_frequency;
            const float shift_ratio = reference_shift_ratio(fa, fb, split, base_frequency) * 0.55F;
            apply_shift_pair(a[i], b[best], a_pitch, b_pitch, shift_ratio, max_cents);
        }
        return;
    }

    std::array<float, kMaxPartials> shifted_a = a;
    std::array<float, kMaxPartials> shifted_b = b;
    for (std::size_t i = 0; i < kMaxPartials; ++i) {
        const float fa_ratio = a[i] * a_pitch;
        if (fa_ratio >= 10000.0F) continue;
        for (std::size_t j = 0; j < kMaxPartials; ++j) {
            const float fb_ratio = b[j] * b_pitch;
            if (fb_ratio >= 10000.0F || std::abs(fa_ratio - fb_ratio) > 4.0F) continue;
            const float fa = fa_ratio * base_frequency;
            const float fb = fb_ratio * base_frequency;
            const float shift_ratio = reference_shift_ratio(fa, fb, split, base_frequency);
            if (fa_ratio > fb_ratio) {
                shifted_a[i] += shift_ratio / std::max(1.0e-5F, a_pitch);
                shifted_b[j] -= shift_ratio / std::max(1.0e-5F, b_pitch);
            } else {
                shifted_a[i] -= shift_ratio / std::max(1.0e-5F, a_pitch);
                shifted_b[j] += shift_ratio / std::max(1.0e-5F, b_pitch);
            }
        }
    }

    for (std::size_t i = 0; i < kMaxPartials; ++i) {
        if (patch.coupling_profile == CouplingProfile::Reference) {
            a[i] = clamp_shifted_ratio(a[i], shifted_a[i], a_pitch, max_cents);
            b[i] = clamp_shifted_ratio(b[i], shifted_b[i], b_pitch, max_cents);
        } else {
            a[i] = std::max(1.0e-5F, shifted_a[i]);
            b[i] = std::max(1.0e-5F, shifted_b[i]);
        }
    }
}
