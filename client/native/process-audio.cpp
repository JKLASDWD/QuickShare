// SPDX-License-Identifier: GPL-3.0-or-later
// OBS Studio audio capture reference: Copyright OBS Studio contributors.
// Upstream OBS Studio is GPL-2.0-or-later; this adaptation is distributed
// under GPL-3.0-or-later. See ../../THIRD_PARTY_NOTICES.md for provenance.
// QuickShare adaptation: standalone process-tree capture, pipe PCM output,
// window lifetime checks and stop handling. License notice added 2026-10-04.
// This program comes WITHOUT ANY WARRANTY; see ../../LICENSE.
// QuickShare process-tree loopback. PCM is streamed over an anonymous pipe;
// no DLL injection, virtual sound driver, graphics capture, or recording files.
#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <ks.h>
#include <ksmedia.h>
#include <wrl.h>
#include <wrl/implements.h>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <string>

using Microsoft::WRL::ComPtr;
class Activation final : public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
    Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
    HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HRESULT result = E_PENDING;
    ComPtr<IAudioClient> client;
    ~Activation() { if (done) CloseHandle(done); }
    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT activated = E_FAIL;
        ComPtr<IUnknown> object;
        result = operation->GetActivateResult(&activated, &object);
        if (SUCCEEDED(result)) result = activated;
        if (SUCCEEDED(result)) result = object.As(&client);
        SetEvent(done);
        return S_OK;
    }
};
int fail(const char* stage, HRESULT result) {
    std::fprintf(stderr, "{\"event\":\"error\",\"stage\":\"%s\",\"hresult\":\"0x%08lX\"}\n", stage, static_cast<unsigned long>(result));
    std::fflush(stderr);
    return 1;
}
struct Handle {
    HANDLE value = nullptr;
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
DWORD WINAPI watchInput(void* arg) {
    char byte; DWORD size = 0;
    ReadFile(GetStdHandle(STD_INPUT_HANDLE), &byte, 1, &size, nullptr);
    SetEvent(static_cast<HANDLE>(arg));
    return 0;
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 3 || std::wstring(argv[1]) != L"--window") return fail("arguments", E_INVALIDARG);
    wchar_t* end = nullptr;
    unsigned long long number = std::wcstoull(argv[2], &end, 10);
    if (!number || !end || *end) return fail("window", E_INVALIDARG);
    HWND window = reinterpret_cast<HWND>(static_cast<uintptr_t>(number));
    DWORD pid = 0;
    if (!IsWindow(window) || !GetWindowThreadProcessId(window, &pid) || !pid) return fail("window", E_INVALIDARG);
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) return fail("com", hr);
    auto activation = Microsoft::WRL::Make<Activation>();
    if (!activation || !activation->done) return fail("event", E_OUTOFMEMORY);
    AUDIOCLIENT_ACTIVATION_PARAMS parameters{};
    parameters.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    parameters.ProcessLoopbackParams.TargetProcessId = pid;
    parameters.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT property{};
    property.vt = VT_BLOB;
    property.blob.cbSize = sizeof(parameters);
    property.blob.pBlobData = reinterpret_cast<BYTE*>(&parameters);
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &property, activation.Get(), &operation);
    if (FAILED(hr)) return fail("activate", hr);
    if (WaitForSingleObject(activation->done, 8000) != WAIT_OBJECT_0) return fail("activation-timeout", HRESULT_FROM_WIN32(WAIT_TIMEOUT));
    if (FAILED(activation->result)) return fail("activate", activation->result);
    auto client = activation->client;
    WAVEFORMATEXTENSIBLE format{};
    format.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    format.Format.nChannels = 2;
    format.Format.nSamplesPerSec = 48000;
    format.Format.wBitsPerSample = 32;
    format.Format.nBlockAlign = 8;
    format.Format.nAvgBytesPerSec = 48000 * 8;
    format.Format.cbSize = sizeof(format) - sizeof(WAVEFORMATEX);
    format.Samples.wValidBitsPerSample = 32;
    format.dwChannelMask = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
    format.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 200000, 0, &format.Format, nullptr);
    if (FAILED(hr)) return fail("initialize", hr);
    Handle sample{CreateEventW(nullptr, FALSE, FALSE, nullptr)};
    Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    if (!sample.value || !stop.value) return fail("event", E_OUTOFMEMORY);
    hr = client->SetEventHandle(sample.value);
    if (FAILED(hr)) return fail("event-handle", hr);
    ComPtr<IAudioCaptureClient> capture;
    hr = client->GetService(IID_PPV_ARGS(&capture));
    if (FAILED(hr)) return fail("capture-service", hr);
    Handle inputThread{CreateThread(nullptr, 0, watchInput, stop.value, 0, nullptr)};
    if (!inputThread.value) return fail("input-thread", HRESULT_FROM_WIN32(GetLastError()));
    hr = client->Start();
    if (FAILED(hr)) return fail("start", hr);
    std::fprintf(stderr, "{\"event\":\"ready\",\"pid\":%lu,\"sampleRate\":48000,\"channels\":2}\n", pid);
    std::fflush(stderr);
    HANDLE waits[] = {stop.value, sample.value};
    std::vector<BYTE> silence;
    int code = 0;
    while (true) {
        DWORD wait = WaitForMultipleObjects(2, waits, FALSE, 250);
        if (wait == WAIT_OBJECT_0) break;
        DWORD currentPid = 0;
        if (!IsWindow(window) || !GetWindowThreadProcessId(window, &currentPid) || currentPid != pid) { code = fail("window-closed", HRESULT_FROM_WIN32(ERROR_INVALID_WINDOW_HANDLE)); break; }
        if (wait == WAIT_TIMEOUT) continue;
        if (wait != WAIT_OBJECT_0 + 1) { code = fail("wait", HRESULT_FROM_WIN32(GetLastError())); break; }
        UINT32 available = 0;
        while (SUCCEEDED(hr = capture->GetNextPacketSize(&available)) && available) {
            BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
            hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
            if (FAILED(hr)) break;
            const DWORD bytes = frames * format.Format.nBlockAlign;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) { silence.assign(bytes, 0); data = silence.data(); }
            DWORD written = 0;
            const bool ok = WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), data, bytes, &written, nullptr) && written == bytes;
            capture->ReleaseBuffer(frames);
            if (!ok) { SetEvent(stop.value); break; }
        }
        if (FAILED(hr)) { code = fail("read", hr); break; }
    }
    client->Stop();
    CancelSynchronousIo(inputThread.value);
    WaitForSingleObject(inputThread.value, 1000);
    capture.Reset(); client.Reset(); operation.Reset(); activation.Reset();
    CoUninitialize();
    return code;
}
