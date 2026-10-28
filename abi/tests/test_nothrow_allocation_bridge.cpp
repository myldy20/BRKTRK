#include <cstddef>
#include <cstdlib>
#include <new>

// test_module_runtime.cpp replaces the ordinary global new/delete pair with a
// malloc/free-backed allocation counter. ModuleRuntime intentionally creates
// Engine with new(std::nothrow), which is a separate overload and otherwise
// bypasses that test allocator. Under ASan this makes the test harness pair a
// standard nothrow-new allocation with its custom free-backed delete.
//
// Provide the missing nothrow overloads for this fixture only so every global
// allocation family used by the fixture has the same malloc/free backend. This
// is a test-harness correction; production ModuleRuntime ownership is unchanged.

void* operator new(std::size_t size, const std::nothrow_t&) noexcept {
    return std::malloc(size == 0U ? 1U : size);
}

void* operator new[](std::size_t size, const std::nothrow_t&) noexcept {
    return std::malloc(size == 0U ? 1U : size);
}

void operator delete(void* memory, const std::nothrow_t&) noexcept {
    std::free(memory);
}

void operator delete[](void* memory, const std::nothrow_t&) noexcept {
    std::free(memory);
}
