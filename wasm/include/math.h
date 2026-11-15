#pragma once
#define floor __builtin_floor
#define ceil __builtin_ceil
#define fabs __builtin_fabs
#define sqrt __builtin_sqrt
#define floorf __builtin_floorf
#define ceilf __builtin_ceilf
#define fabsf __builtin_fabsf
#define sqrtf __builtin_sqrtf
double pow(double a, double b);
double sin(double x);
double cos(double x);
double exp(double x);
double log(double x);
double tan(double x);
double atan(double x);
double atan2(double y, double x);
double asin(double x);
double acos(double x);
double fmod(double a, double b);
double log10(double x);
double round(double x);
double trunc(double x);
float sinf(float x);
float cosf(float x);
float powf(float a, float b);
float expf(float x);
float logf(float x);
float roundf(float x);
#define fmin(a, b) __builtin_fmin(a, b)
#define fmax(a, b) __builtin_fmax(a, b)
#define M_PI 3.14159265358979323846
