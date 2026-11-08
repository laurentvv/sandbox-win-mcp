#define UNICODE
#define _UNICODE
#include <windows.h>

LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam)
{
    switch (message) {
    case WM_CREATE:
        CreateWindow(L"BUTTON", L"Greet", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
            20, 20, 400, 48, hwnd, (HMENU)100, nullptr, nullptr);
        CreateWindow(L"STATIC", L"Ready", WS_CHILD | WS_VISIBLE,
            20, 90, 400, 48, hwnd, (HMENU)101, nullptr, nullptr);
        return 0;
    case WM_COMMAND:
        if (LOWORD(wparam) == 100) SetDlgItemText(hwnd, 101, L"Hello from native Win32");
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(hwnd, message, wparam, lparam);
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show)
{
    WNDCLASS wc = {};
    wc.lpfnWndProc = WindowProc;
    wc.hInstance = instance;
    wc.lpszClassName = L"SandboxNative";
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    if (!RegisterClass(&wc)) return 1;
    HWND window = CreateWindow(wc.lpszClassName, L"Sandbox Native Win32", WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT, 480, 240, nullptr, nullptr, instance, nullptr);
    if (!window) return 2;
    ShowWindow(window, show);
    MSG message = {};
    int result;
    while ((result = GetMessage(&message, nullptr, 0, 0)) > 0) {
        TranslateMessage(&message);
        DispatchMessage(&message);
    }
    return result < 0 ? 3 : (int)message.wParam;
}
