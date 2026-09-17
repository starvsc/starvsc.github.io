cmake_minimum_required(VERSION 3.16)
project(DynamicTemporalConsistencyDetection VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

if(MSVC)
  add_compile_options(/utf-8)
endif()

# 生产库只依赖这些模块;若有新依赖需求请在 README 说明
# 说明:core/imgproc/video(光流)/dnn(未来 landmark)/videoio+highgui(demo 用)
find_package(OpenCV REQUIRED COMPONENTS
  core imgproc video calib3d videoio highgui imgcodecs objdetect dnn)
message(STATUS "OpenCV ${OpenCV_VERSION}")

# 本项目用了 cv::FaceDetectorYN(OpenCV 4.5.4 引入),老版本编不过。
# Ubuntu 20.04 的 apt 自带的 OpenCV 是 4.2,需源码编译新版(见 Ubuntu_使用说明.md 附录 A)。
if(OpenCV_VERSION VERSION_LESS "4.5.4")
  message(FATAL_ERROR
    "需要 OpenCV >= 4.5.4(当前 ${OpenCV_VERSION});"
    "Ubuntu 20.04 的 apt 只有 4.2,请先源码编译新版 OpenCV,见 Ubuntu_使用说明.md 附录 A。")
endif()

# ------------------------------------------------------------------
# mod3 —— 生产核心库(纯算法,可编 WASM)
# 约束:不出现平台/文件/网络/摄像头调用;不加载任何模型。
# 未来 WASM 适配只需在此库外包一层 extern "C" 壳(mod3_create/push/analyze/destroy)。
# ------------------------------------------------------------------
add_library(mod3 STATIC src/mod3.cpp)
target_include_directories(mod3 PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(mod3 PUBLIC ${OpenCV_LIBS})

# ------------------------------------------------------------------
# mod3_demo —— 本地测试骨架(不进浏览器)
# 帧源:摄像头 / 视频文件 / 视频目录;内嵌 YuNet 人脸检测 + 可插拔 68 点 landmark。
# ------------------------------------------------------------------
add_executable(mod3_demo
  demo/mod3_demo.cpp
  demo/pipnet_provider.cpp)
target_link_libraries(mod3_demo PRIVATE mod3 ${OpenCV_LIBS})

# GCC < 10(如 Ubuntu 20.04 自带 gcc 9)用 std::filesystem 需额外链 stdc++fs
if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU" AND CMAKE_CXX_COMPILER_VERSION VERSION_LESS "10.0")
  target_link_libraries(mod3_demo PRIVATE stdc++fs)
endif()

# 可选:example 采集器 / 评测脚本,后续 M4 再加
