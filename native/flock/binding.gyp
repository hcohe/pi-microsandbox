{
  "targets": [
    {
      "target_name": "flock",
      "sources": ["src/flock.c"],
      "defines": ["NAPI_VERSION=10"],
      "cflags": [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-fvisibility=hidden",
        "-fstack-protector-strong"
      ],
      "conditions": [
        ["OS == 'linux'", {
          "ldflags": ["-Wl,-z,relro,-z,now", "-Wl,--as-needed"]
        }],
        ["OS == 'mac'", {
          "xcode_settings": {
            "CLANG_C_LANGUAGE_STANDARD": "c11",
            "GCC_SYMBOLS_PRIVATE_EXTERN": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CFLAGS": [
              "-Wall",
              "-Wextra",
              "-Werror",
              "-fvisibility=hidden",
              "-fstack-protector-strong"
            ],
            "OTHER_LDFLAGS": ["-Wl,-dead_strip"]
          }
        }]
      ]
    }
  ]
}
