@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo 正在创建 .venv 虚拟环境...
    py -3 -m venv .venv
)

echo 正在安装/检查依赖，使用清华 PyPI 镜像源...
".venv\Scripts\python.exe" -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

echo.
set /p LANEWAY_PORT=请输入端口号，直接回车默认 8000:
if "%LANEWAY_PORT%"=="" set LANEWAY_PORT=8000
echo 正在使用端口 %LANEWAY_PORT% 运行 Laneway main.py...
echo.
".venv\Scripts\python.exe" main.py --port %LANEWAY_PORT%
pause
