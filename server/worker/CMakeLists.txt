cmake_minimum_required(VERSION 3.16)
project(faceauth_worker LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs objdetect calib3d)
find_package(Threads REQUIRED)
find_package(OpenSSL REQUIRED)

# 队友 faceauth 目录(含 include/ 与 build/libfaceauth.a)
set(FACEAUTH_ROOT "" CACHE PATH "Path to teammate faceauth dir (contains include/ and build/)")
if(NOT FACEAUTH_ROOT)
  get_filename_component(_PROJ "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
  set(FACEAUTH_ROOT "${_PROJ}/faceauth")
endif()

# onnxruntime(同队友编译方式)
find_path(ONNXRUNTIME_INCLUDE_DIR onnxruntime_cxx_api.h HINTS ${ONNXRUNTIME_ROOT}/include)
find_library(ONNXRUNTIME_LIBRARY NAMES onnxruntime HINTS ${ONNXRUNTIME_ROOT}/lib)
# MySQL client(数据库用)
find_path(MYSQL_INCLUDE_DIR mysql.h PATH_SUFFIXES mysql)
find_library(MYSQL_LIBRARY NAMES mysqlclient)

message(STATUS "FACEAUTH_ROOT = ${FACEAUTH_ROOT}")
message(STATUS "ONNXRUNTIME   = ${ONNXRUNTIME_LIBRARY}")
message(STATUS "MYSQLCLIENT   = ${MYSQL_LIBRARY}")
if(NOT ONNXRUNTIME_LIBRARY OR NOT MYSQL_LIBRARY)
  message(FATAL_ERROR "缺少 onnxruntime 或 mysqlclient,请先按队友 setup_m0.sh 安装")
endif()

add_executable(faceauth_worker faceauth_worker.cpp)

target_include_directories(faceauth_worker PRIVATE
  ${FACEAUTH_ROOT}/include
  ${OpenCV_INCLUDE_DIRS}
  ${ONNXRUNTIME_INCLUDE_DIR}
  ${MYSQL_INCLUDE_DIR})

target_link_libraries(faceauth_worker PRIVATE
  ${FACEAUTH_ROOT}/build/libfaceauth.a
  ${OpenCV_LIBS}
  ${ONNXRUNTIME_LIBRARY}
  ${MYSQL_LIBRARY}
  OpenSSL::Crypto
  Threads::Threads)
