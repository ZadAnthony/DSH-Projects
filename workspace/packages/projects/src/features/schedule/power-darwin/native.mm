#include <node_api.h>
#import <AppKit/NSWorkspace.h>
#import <Foundation/Foundation.h>
#include <CoreFoundation/CoreFoundation.h>
#include <mach/mach_time.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <pthread.h>
#include <array>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <exception>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace {
napi_value String(napi_env env, const std::string& value) {
  napi_value out; napi_create_string_utf8(env, value.c_str(), value.size(), &out); return out;
}
napi_value Object(napi_env env) { napi_value out; napi_create_object(env, &out); return out; }
void Set(napi_env env, napi_value obj, const char* key, napi_value value) { napi_set_named_property(env, obj, key, value); }
void Text(napi_env env, napi_value obj, const char* key, const std::string& value) { Set(env, obj, key, String(env, value)); }
void Number(napi_env env, napi_value obj, const char* key, double value) {
  napi_value out; napi_create_double(env, value, &out); Set(env, obj, key, out);
}
void Bool(napi_env env, napi_value obj, const char* key, bool value) {
  napi_value out; napi_get_boolean(env, value, &out); Set(env, obj, key, out);
}
napi_value Undefined(napi_env env) { napi_value out; napi_get_undefined(env, &out); return out; }
bool ReadString(napi_env env, napi_value value, std::string& out) {
  napi_valuetype type; if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t len = 0; napi_get_value_string_utf8(env, value, nullptr, 0, &len);
  out.resize(len + 1); napi_get_value_string_utf8(env, value, out.data(), out.size(), &len); out.resize(len); return true;
}

struct Clock {
  uint64_t absolute = 0, continuous = 0;
  timeval wall{}; int wallRc = 0, wallErrno = 0;
};
Clock ReadClock() {
  Clock out; out.absolute = mach_absolute_time(); out.continuous = mach_continuous_time();
  errno = 0; out.wallRc = gettimeofday(&out.wall, nullptr); out.wallErrno = errno; return out;
}
napi_value ClockObject(napi_env env, const Clock& clock) {
  napi_value out = Object(env);
  Text(env, out, "absoluteTicks", std::to_string(clock.absolute));
  Text(env, out, "continuousTicks", std::to_string(clock.continuous));
  Text(env, out, "wallSeconds", std::to_string(clock.wall.tv_sec));
  Number(env, out, "wallMicroseconds", clock.wall.tv_usec);
  Number(env, out, "wallRc", clock.wallRc); Number(env, out, "wallErrno", clock.wallErrno); return out;
}
struct Field {
  const char* oid; bool isTimeval; size_t expected, queried = 0, returned = 0;
  int queryRc = -1, queryErrno = 0, readRc = -1, readErrno = 0;
  bool readAttempted = false; std::array<unsigned char, sizeof(timeval)> bytes{};
};
Field ReadField(const char* oid, bool isTimeval, bool shortBuffer = false) {
  Field out{oid, isTimeval, isTimeval ? sizeof(timeval) : sizeof(uint64_t)};
  errno = 0; out.queryRc = sysctlbyname(oid, nullptr, &out.queried, nullptr, 0); out.queryErrno = errno;
  if (out.queryRc != 0) return out;
  out.readAttempted = true; out.returned = shortBuffer ? 1 : out.expected;
  errno = 0; out.readRc = sysctlbyname(oid, out.bytes.data(), &out.returned, nullptr, 0); out.readErrno = errno;
  return out;
}
napi_value FieldObject(napi_env env, const Field& field) {
  napi_value out = Object(env); Text(env, out, "oid", field.oid);
  Text(env, out, "domain", field.isTimeval ? "kernel-calendar-timeval" : "mach-absolute-ticks");
  Number(env, out, "expectedBytes", field.expected); Number(env, out, "queriedBytes", field.queried);
  Number(env, out, "returnedBytes", field.returned); Number(env, out, "queryRc", field.queryRc);
  Number(env, out, "queryErrno", field.queryErrno); Number(env, out, "readRc", field.readRc);
  Number(env, out, "readErrno", field.readErrno); Bool(env, out, "readAttempted", field.readAttempted);
  const bool valid = field.queryRc == 0 && field.readAttempted && field.readRc == 0 &&
    field.queried == field.expected && field.returned == field.expected;
  Bool(env, out, "decoded", valid);
  if (!valid) return out;
  static const char hex[] = "0123456789abcdef"; std::string raw;
  for (size_t i = 0; i < field.returned; ++i) { raw += hex[field.bytes[i] >> 4]; raw += hex[field.bytes[i] & 15]; }
  Text(env, out, "bytesHex", raw);
  if (field.isTimeval) {
    timeval tv{}; std::memcpy(&tv, field.bytes.data(), sizeof(tv));
    Text(env, out, "seconds", std::to_string(tv.tv_sec)); Number(env, out, "microseconds", tv.tv_usec);
  } else {
    uint64_t ticks = 0; std::memcpy(&ticks, field.bytes.data(), sizeof(ticks)); Text(env, out, "ticks", std::to_string(ticks));
  }
  return out;
}
napi_value Sample(napi_env env, const std::string& fault = "") {
  const Field epochBefore = ReadField("kern.sleep_abs_time", false);
  const Clock before = ReadClock(); mach_timebase_info_data_t timebase{};
  const kern_return_t tbRc = mach_timebase_info(&timebase);
  const Field sleep = ReadField("kern.sleeptime", true);
  const Field wake = ReadField(fault == "missing-oid" ? "kern.dsh_projects_nonexistent_power_field" : "kern.waketime", true, fault == "short-timeval");
  const Field sleepAbs = ReadField("kern.sleep_abs_time", false);
  const Field wakeAbs = ReadField("kern.wake_abs_time", false, fault == "short-ticks");
  const Field boot = ReadField("kern.boottime", true); const Clock after = ReadClock();
  const Field epochAfter = ReadField("kern.sleep_abs_time", false);
  napi_value out = Object(env); Number(env, out, "version", 1); Text(env, out, "source", "darwin-sysctl-mach");
  Text(env, out, "byteOrder", "LE");
  Number(env, out, "pointerBytes", sizeof(void*)); Number(env, out, "timevalBytes", sizeof(timeval));
  Number(env, out, "timevalSecondsBytes", sizeof(timeval::tv_sec)); Number(env, out, "timevalMicrosecondsBytes", sizeof(timeval::tv_usec));
  Number(env, out, "timebaseRc", tbRc); Number(env, out, "timebaseNumer", timebase.numer); Number(env, out, "timebaseDenom", timebase.denom);
  Set(env, out, "before", ClockObject(env, before)); Set(env, out, "after", ClockObject(env, after));
  Set(env, out, "epochBefore", FieldObject(env, epochBefore)); Set(env, out, "epochAfter", FieldObject(env, epochAfter));
  napi_value fields = Object(env); Set(env, fields, "sleep", FieldObject(env, sleep)); Set(env, fields, "wake", FieldObject(env, wake));
  Set(env, fields, "sleepAbsolute", FieldObject(env, sleepAbs)); Set(env, fields, "wakeAbsolute", FieldObject(env, wakeAbs));
  Set(env, fields, "boot", FieldObject(env, boot)); Set(env, out, "fields", fields); return out;
}
napi_value ReadRaw(napi_env env, napi_callback_info) { return Sample(env); }

struct Packet { std::string kind, source; uint64_t sequence, nativeThread; Clock clock; };
struct State {
  std::mutex mutex; std::condition_variable ready; std::thread worker;
  std::atomic<bool> closed{false}, finalized{false}; bool started = false, subscribed = false;
  CFRunLoopRef loop = nullptr; napi_threadsafe_function tsfn = nullptr;
  uint64_t sequence = 0, delivered = 0, dropped = 0; int deliveryStatus = napi_ok;
  std::string backend, error;
  void Dispatch(const std::string& kind) {
    std::lock_guard<std::mutex> lock(mutex); if (closed) return;
    uint64_t thread = 0; pthread_threadid_np(nullptr, &thread);
    auto* packet = new Packet{kind, backend == "controlled" ? "controlled-native-thread" : "nsworkspace", ++sequence, thread, ReadClock()};
    const napi_status rc = napi_call_threadsafe_function(tsfn, packet, napi_tsfn_nonblocking);
    deliveryStatus = rc; if (rc != napi_ok) { ++dropped; delete packet; }
  }
  void Run() {
    @autoreleasepool {
      NSNotificationCenter* center = nil; id sleepObserver = nil, wakeObserver = nil;
      CFRunLoopSourceContext context{}; CFRunLoopSourceRef keepalive = CFRunLoopSourceCreate(nullptr, 0, &context);
      CFRunLoopRef current = CFRunLoopGetCurrent(); CFRetain(current);
      CFRunLoopAddSource(current, keepalive, kCFRunLoopCommonModes);
      @try {
        if (backend == "nsworkspace") {
          center = NSWorkspace.sharedWorkspace.notificationCenter;
          sleepObserver = [center addObserverForName:NSWorkspaceWillSleepNotification object:nil queue:nil usingBlock:^(NSNotification*) { Dispatch("will-sleep"); }];
          wakeObserver = [center addObserverForName:NSWorkspaceDidWakeNotification object:nil queue:nil usingBlock:^(NSNotification*) { Dispatch("did-wake"); }];
        }
      } @catch (NSException* exception) { error = exception.reason.UTF8String ?: "NSWorkspace exception"; }
      {
        std::lock_guard<std::mutex> lock(mutex); loop = current; subscribed = backend == "nsworkspace" && sleepObserver && wakeObserver;
        started = true; ready.notify_one();
      }
      if (error.empty()) CFRunLoopRun();
      if (sleepObserver) [center removeObserver:sleepObserver]; if (wakeObserver) [center removeObserver:wakeObserver];
      CFRunLoopRemoveSource(current, keepalive, kCFRunLoopCommonModes); CFRelease(keepalive);
      { std::lock_guard<std::mutex> lock(mutex); loop = nullptr; subscribed = false; }
      CFRelease(current);
    }
  }
  void Close() {
    {
      std::lock_guard<std::mutex> lock(mutex); if (closed.exchange(true)) return;
      if (loop) {
        CFRunLoopRef current = loop;
        CFRunLoopPerformBlock(current, kCFRunLoopCommonModes, ^{ CFRunLoopStop(current); });
        CFRunLoopWakeUp(current);
      }
    }
    if (worker.joinable()) worker.join();
    // producer 已停止，之后排到 Node 的 packet 只释放，不再进入业务 callback。
    if (tsfn) { napi_release_threadsafe_function(tsfn, napi_tsfn_release); tsfn = nullptr; }
  }
};
using Shared = std::shared_ptr<State>;
struct Handle { Shared state; napi_env env; };
void Cleanup(void* data) { static_cast<Handle*>(data)->state->Close(); }
void Finalize(napi_env env, void* data, void*) {
  auto* handle = static_cast<Handle*>(data); handle->state->Close();
  napi_remove_env_cleanup_hook(env, Cleanup, handle); delete handle;
}
void CallJs(napi_env env, napi_value callback, void* context, void* data) {
  std::unique_ptr<Packet> packet(static_cast<Packet*>(data)); auto* state = static_cast<State*>(context);
  if (!env || !callback || state->closed) { std::lock_guard<std::mutex> lock(state->mutex); ++state->dropped; return; }
  napi_value out = Object(env); Text(env, out, "kind", packet->kind); Text(env, out, "source", packet->source);
  Text(env, out, "sequence", std::to_string(packet->sequence)); Text(env, out, "nativeThread", std::to_string(packet->nativeThread));
  Set(env, out, "receipt", ClockObject(env, packet->clock));
  uint64_t thread = 0; pthread_threadid_np(nullptr, &thread); Text(env, out, "nodeThread", std::to_string(thread));
  napi_value receiver = Undefined(env), result; const napi_status rc = napi_call_function(env, receiver, callback, 1, &out, &result);
  { std::lock_guard<std::mutex> lock(state->mutex); state->deliveryStatus = rc; if (rc == napi_ok) ++state->delivered; else ++state->dropped; }
  if (rc == napi_pending_exception) { napi_value exception; napi_get_and_clear_last_exception(env, &exception); }
}
Handle* Unwrap(napi_env env, napi_callback_info info, size_t* argc = nullptr, napi_value* argv = nullptr) {
  napi_value self; size_t count = argc ? *argc : 0; napi_get_cb_info(env, info, &count, argv, &self, nullptr);
  if (argc) *argc = count; Handle* handle = nullptr;
  if (napi_unwrap(env, self, reinterpret_cast<void**>(&handle)) != napi_ok || !handle) {
    napi_throw_type_error(env, nullptr, "invalid power subscription receiver"); return nullptr;
  }
  return handle;
}
napi_value Close(napi_env env, napi_callback_info info) {
  auto* h = Unwrap(env, info); if (!h) return nullptr; h->state->Close(); return Undefined(env);
}
napi_value Status(napi_env env, napi_callback_info info) {
  auto* h = Unwrap(env, info); if (!h) return nullptr;
  auto& state = *h->state; std::lock_guard<std::mutex> lock(state.mutex);
  napi_value out = Object(env); Text(env, out, "backend", state.backend); Bool(env, out, "closed", state.closed);
  Bool(env, out, "subscribed", state.subscribed); Bool(env, out, "finalized", state.finalized);
  Text(env, out, "sequence", std::to_string(state.sequence)); Text(env, out, "delivered", std::to_string(state.delivered));
  Text(env, out, "dropped", std::to_string(state.dropped)); Number(env, out, "deliveryStatus", state.deliveryStatus); Text(env, out, "error", state.error); return out;
}
napi_value Emit(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; auto* h = Unwrap(env, info, &argc, argv); std::string kind;
  if (!h) return nullptr;
  if (h->state->backend != "controlled" || argc != 1 || !ReadString(env, argv[0], kind) || (kind != "will-sleep" && kind != "did-wake")) {
    napi_throw_type_error(env, nullptr, "controlled backend and will-sleep/did-wake required"); return nullptr;
  }
  auto* state = h->state.get(); std::lock_guard<std::mutex> lock(state->mutex);
  if (state->closed || !state->loop) { napi_throw_error(env, nullptr, "subscription closed"); return nullptr; }
  CFRunLoopPerformBlock(state->loop, kCFRunLoopCommonModes, ^{ state->Dispatch(kind); }); CFRunLoopWakeUp(state->loop);
  return Undefined(env);
}
napi_value Subscribe(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string backend; napi_valuetype type;
  if (argc != 2 || !ReadString(env, argv[0], backend) || (backend != "controlled" && backend != "nsworkspace") ||
      napi_typeof(env, argv[1], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "subscribe requires explicit backend and callback"); return nullptr;
  }
  Shared state = std::make_shared<State>(); state->backend = backend;
  auto* hold = new Shared(state);
  const napi_status rc = napi_create_threadsafe_function(env, argv[1], nullptr, String(env, "dsh-projects-power-hint"), 0, 1, hold,
    [](napi_env, void* data, void*) { auto* value = static_cast<Shared*>(data); (*value)->finalized = true; delete value; }, state.get(), CallJs, &state->tsfn);
  if (rc != napi_ok) { delete hold; napi_throw_error(env, nullptr, "cannot create power TSFN"); return nullptr; }
  if (napi_unref_threadsafe_function(env, state->tsfn) != napi_ok) {
    state->Close(); napi_throw_error(env, nullptr, "cannot unreference power TSFN"); return nullptr;
  }
  try { state->worker = std::thread([raw = state.get()] { raw->Run(); }); }
  catch (const std::exception& error) { state->Close(); napi_throw_error(env, nullptr, error.what()); return nullptr; }
  { std::unique_lock<std::mutex> lock(state->mutex); state->ready.wait(lock, [&] { return state->started; }); }
  if (!state->error.empty() || (backend == "nsworkspace" && !state->subscribed)) {
    state->Close(); napi_throw_error(env, nullptr, state->error.empty() ? "NSWorkspace subscription unavailable" : state->error.c_str()); return nullptr;
  }
  napi_value out = Object(env); auto* handle = new Handle{state, env};
  napi_wrap(env, out, handle, Finalize, nullptr, nullptr); napi_add_env_cleanup_hook(env, Cleanup, handle);
  const napi_property_descriptor props[] = {
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"emitControlled", nullptr, Emit, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, out, sizeof(props) / sizeof(props[0]), props); return out;
}
#ifdef DSH_POWER_TESTING
napi_value TestRead(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr); std::string fault;
  if (argc != 1 || !ReadString(env, argv[0], fault) || (fault != "missing-oid" && fault != "short-timeval" && fault != "short-ticks")) {
    napi_throw_type_error(env, nullptr, "unsupported test read fault"); return nullptr;
  }
  return Sample(env, fault);
}
#endif
napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor props[] = {
    {"readRawSync", nullptr, ReadRaw, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"subscribe", nullptr, Subscribe, nullptr, nullptr, nullptr, napi_default, nullptr},
#ifdef DSH_POWER_TESTING
    {"testReadFault", nullptr, TestRead, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  Number(env, exports, "apiVersion", 1); Number(env, exports, "napiVersion", NAPI_VERSION);
#ifdef DSH_POWER_TESTING
  Text(env, exports, "buildKind", "controlled-test");
#else
  Text(env, exports, "buildKind", "native");
#endif
  return exports;
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
