"""設定載入：APP_ENV 與舊名 NODE_ENV 的相容。"""

import pytest

from server.app.config import ConfigError, load_config


def test_default_is_development():
    c = load_config({})
    assert c.APP_ENV == "development" and c.is_production is False


def test_app_env_production():
    assert load_config({"APP_ENV": "production"}).is_production is True


def test_legacy_node_env_still_works():
    assert load_config({"NODE_ENV": "production"}).is_production is True


def test_app_env_wins_over_node_env():
    assert load_config({"APP_ENV": "development", "NODE_ENV": "production"}).is_production is False


def test_invalid_value_names_the_variable_actually_read():
    with pytest.raises(ConfigError, match="NODE_ENV"):
        load_config({"NODE_ENV": "prod"})
    with pytest.raises(ConfigError, match="APP_ENV"):
        load_config({"APP_ENV": "prod"})


def test_removed_variables_are_ignored():
    c = load_config({"STATIC_DIR": "dist/web", "WEB_PORT": "5173"})
    assert not hasattr(c, "STATIC_DIR") and not hasattr(c, "WEB_PORT")
