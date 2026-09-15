#include <errno.h>
#include <limits.h>
#include <node_api.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>

static napi_value throw_type_error(napi_env env, const char *message) {
  napi_throw_type_error(env, NULL, message);
  return NULL;
}

static napi_value throw_napi_error(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

static const char *errno_code(int error_number) {
  if (error_number == EAGAIN) return "EAGAIN";
#ifdef EWOULDBLOCK
  if (error_number == EWOULDBLOCK) return "EAGAIN";
#endif
  if (error_number == EBADF) return "EBADF";
  if (error_number == EINTR) return "EINTR";
  if (error_number == EINVAL) return "EINVAL";
  if (error_number == ENOLCK) return "ENOLCK";
#ifdef ENOSYS
  if (error_number == ENOSYS) return "ENOSYS";
#endif
#ifdef ENOTSUP
  if (error_number == ENOTSUP) return "ENOTSUP";
#endif
#if defined(EOPNOTSUPP) && (!defined(ENOTSUP) || EOPNOTSUPP != ENOTSUP)
  if (error_number == EOPNOTSUPP) return "ENOTSUP";
#endif
  return "UNKNOWN";
}

static napi_value throw_flock_error(napi_env env, int error_number) {
  char message[256];
  const char *detail = strerror(error_number);
  napi_value message_value;
  napi_value error;
  napi_value code;
  napi_value errno_value;
  napi_value syscall;

  if (detail == NULL) detail = "unknown error";
  int written = snprintf(message, sizeof(message), "flock: %s", detail);
  if (written < 0) return throw_napi_error(env, "flock failed and its error message could not be formatted");

  if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value) != napi_ok ||
      napi_create_error(env, NULL, message_value, &error) != napi_ok ||
      napi_create_string_utf8(env, errno_code(error_number), NAPI_AUTO_LENGTH, &code) != napi_ok ||
      napi_create_int32(env, error_number, &errno_value) != napi_ok ||
      napi_create_string_utf8(env, "flock", NAPI_AUTO_LENGTH, &syscall) != napi_ok ||
      napi_set_named_property(env, error, "code", code) != napi_ok ||
      napi_set_named_property(env, error, "errno", errno_value) != napi_ok ||
      napi_set_named_property(env, error, "syscall", syscall) != napi_ok ||
      napi_throw(env, error) != napi_ok) {
    return throw_napi_error(env, "flock failed and its JavaScript error could not be created");
  }
  return NULL;
}

static napi_value flock_binding(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_valuetype type;
  double fd_number;
  size_t operation_length;
  char operation[5];
  size_t copied;
  int flags;
  napi_value undefined;

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) {
    return throw_napi_error(env, "unable to read flock arguments");
  }
  if (argc != 2) return throw_type_error(env, "flock requires a file descriptor and operation");

  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, argv[0], &fd_number) != napi_ok ||
      fd_number != fd_number || fd_number < 0 || fd_number > INT_MAX ||
      (double)(int)fd_number != fd_number) {
    return throw_type_error(env, "file descriptor must be a non-negative integer");
  }

  if (napi_typeof(env, argv[1], &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, argv[1], NULL, 0, &operation_length) != napi_ok ||
      operation_length >= sizeof(operation) ||
      napi_get_value_string_utf8(env, argv[1], operation, sizeof(operation), &copied) != napi_ok ||
      copied != operation_length) {
    return throw_type_error(env, "operation must be \"exnb\" or \"un\"");
  }

  if (strcmp(operation, "exnb") == 0) flags = LOCK_EX | LOCK_NB;
  else if (strcmp(operation, "un") == 0) flags = LOCK_UN;
  else return throw_type_error(env, "operation must be \"exnb\" or \"un\"");

  if (flock((int)fd_number, flags) != 0) {
    const int error_number = errno;
    return throw_flock_error(env, error_number);
  }

  if (napi_get_undefined(env, &undefined) != napi_ok) {
    return throw_napi_error(env, "flock succeeded but no result could be returned");
  }
  return undefined;
}

NAPI_MODULE_INIT() {
  napi_value function;
  if (napi_create_function(env, "flock", NAPI_AUTO_LENGTH, flock_binding, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "flock", function) != napi_ok) {
    return throw_napi_error(env, "unable to initialize flock addon");
  }
  return exports;
}
