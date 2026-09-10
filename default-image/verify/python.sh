#!/usr/bin/env bash

set -euo pipefail

verify_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${verify_dir}/_common.sh"

require_commands cc pip pip3 python python3 python3-config uv uvx

[[ "$(uv --version)" == "uv 0.12.12" ]]
[[ "$(python -c 'print(6 * 7)')" == "42" ]]

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
cat > "${tmp_dir}/native_probe.c" <<'C'
#include <Python.h>

static PyObject *answer(PyObject *self, PyObject *args) {
    return PyLong_FromLong(42);
}

static PyMethodDef methods[] = {
    {"answer", answer, METH_NOARGS, "Return the answer."},
    {NULL, NULL, 0, NULL}
};

static struct PyModuleDef module = {
    PyModuleDef_HEAD_INIT, "native_probe", NULL, -1, methods
};

PyMODINIT_FUNC PyInit_native_probe(void) {
    return PyModule_Create(&module);
}
C
extension_suffix="$(python3-config --extension-suffix)"
read -r -a python_includes <<< "$(python3-config --includes)"
cc -shared -fPIC "${python_includes[@]}" \
    "${tmp_dir}/native_probe.c" -o "${tmp_dir}/native_probe${extension_suffix}"
PYTHONPATH="${tmp_dir}" python -c \
    'import native_probe; assert native_probe.answer() == 42'
