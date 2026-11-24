from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

from server.app.errors import install_error_handlers, not_found
from server.app.validate import read_json


class TitleInput(BaseModel):
    title: str = Field(min_length=1)


def make_app() -> TestClient:
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/http")
    async def http_error():
        raise not_found("任務不存在")

    @app.post("/validate")
    async def validate(request: Request):
        return (await read_json(request, TitleInput)).model_dump()

    @app.get("/boom")
    async def boom():
        raise RuntimeError("secret detail")

    return TestClient(app, raise_server_exceptions=False)


def test_http_error_format():
    res = make_app().get("/http")
    assert res.status_code == 404
    assert res.json() == {"error": {"code": "NOT_FOUND", "message": "任務不存在"}}


def test_validation_error_400():
    res = make_app().post("/validate", json={"title": ""})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "VALIDATION_ERROR"


def test_non_json_body_400():
    res = make_app().post("/validate", content="not json")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "BAD_REQUEST"


def test_unexpected_error_500_without_details():
    res = make_app().get("/boom")
    assert res.status_code == 500
    assert res.json() == {"error": {"code": "INTERNAL_ERROR", "message": "伺服器發生錯誤"}}
