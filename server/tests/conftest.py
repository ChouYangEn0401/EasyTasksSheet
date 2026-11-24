import warnings

# starlette 新版建議改用 httpx2；TestClient 仍可正常使用
_MSG = "Using `httpx` with `starlette.testclient`"
warnings.filterwarnings("ignore", message=_MSG)


def pytest_configure(config):
    config.addinivalue_line("filterwarnings", f"ignore:{_MSG}")
