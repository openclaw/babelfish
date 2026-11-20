#!/usr/bin/env python3
"""Load Hermes Agent Python plugins for the OpenClaw Hermes bridge.

Input and output are JSON over stdio. This helper intentionally implements the
smallest Hermes host facade needed by OpenClaw:

- ctx.register_tool(...) is callable through hermes_tool_call.
- hooks, middleware, commands, CLI commands, and skills are visible in hermes_plugins_list.
- provider/platform/dashboard/native registrations are listed as unsupported.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import importlib.util
import inspect
import io
import json
import os
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, TypeVar


_PLUGIN_CACHE: dict[str, tuple[dict[str, Any], "RecordingContext"]] = {}


def _load_yaml(path: Path) -> dict[str, Any]:
    try:
        import yaml  # type: ignore

        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return _load_simple_yaml(path)


def _load_simple_yaml(path: Path) -> dict[str, Any]:
    data: dict[str, Any] = {}
    current_list: str | None = None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("- ") and current_list:
            data.setdefault(current_list, []).append(stripped[2:].strip().strip("\"'"))
            continue
        current_list = None
        if ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        key = key.strip()
        value = value.strip()
        if not value:
            data[key] = []
            current_list = key
        elif value.startswith("[") and value.endswith("]"):
            data[key] = [
                item.strip().strip("\"'")
                for item in value[1:-1].split(",")
                if item.strip()
            ]
        else:
            data[key] = value.strip("\"'")
    return data


def _jsonable(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        return repr(value)


@dataclass
class ToolRecord:
    name: str
    toolset: str
    schema: dict[str, Any]
    handler: Callable[..., Any]
    check_fn: Callable[..., Any] | None = None
    requires_env: list[str] = field(default_factory=list)
    is_async: bool = False
    description: str = ""
    emoji: str = ""

    def summary(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "toolset": self.toolset,
            "description": self.description or str(self.schema.get("description") or ""),
            "schema": _jsonable(self.schema),
            "isAsync": self.is_async,
            "requiresEnv": self.requires_env,
            "available": self.available(),
        }

    def available(self) -> bool:
        if self.requires_env and any(not os.getenv(name) for name in self.requires_env):
            return False
        if self.check_fn is None:
            return True
        try:
            return bool(self.check_fn())
        except Exception:
            return False


@dataclass
class CommandRecord:
    name: str
    handler: Callable[..., Any] | None
    description: str = ""
    args_hint: str = ""

    def summary(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "argsHint": self.args_hint,
            "available": self.handler is not None,
        }


@dataclass
class CliCommandRecord:
    name: str
    help: str
    setup_fn: Callable[..., Any] | None
    handler_fn: Callable[..., Any] | None = None
    description: str = ""

    def summary(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description or self.help,
            "argsHint": "",
            "available": self.setup_fn is not None or self.handler_fn is not None,
        }


@dataclass
class HookRecord:
    name: str
    callback: Callable[..., Any]


@dataclass
class MiddlewareRecord:
    kind: str
    callback: Callable[..., Any]


@dataclass
class AuxiliaryTaskRecord:
    key: str
    display_name: str
    description: str
    defaults: dict[str, Any]

    def summary(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "displayName": self.display_name,
            "description": self.description,
            "defaults": _jsonable(self.defaults),
        }


@dataclass
class SkillRecord:
    name: str
    path: Path
    description: str = ""

    def summary(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "path": str(self.path),
            "available": self._content_path() is not None,
        }

    def _content_path(self) -> Path | None:
        if self.path.is_file():
            return self.path
        if not self.path.is_dir():
            return None
        for name in ("SKILL.md", "README.md", f"{self.name}.md"):
            candidate = self.path / name
            if candidate.is_file():
                return candidate
        return None

    def read_text(self) -> str:
        content_path = self._content_path()
        if content_path is None:
            raise RuntimeError(f"Hermes skill '{self.name}' has no readable content file")
        return content_path.read_text(encoding="utf-8")


class RecordingContext:
    def __init__(self, manifest: dict[str, Any], key: str, plugin_dir: Path):
        self.manifest = manifest
        self.key = key
        self.plugin_dir = plugin_dir
        self.tools: list[ToolRecord] = []
        self.hooks: list[HookRecord] = []
        self.middleware: list[MiddlewareRecord] = []
        self.commands: list[CommandRecord] = []
        self.cli_commands: list[CliCommandRecord] = []
        self.skills: list[SkillRecord] = []
        self.auxiliary_tasks: list[AuxiliaryTaskRecord] = []
        self.unsupported: list[str] = []

    @property
    def profile_name(self) -> str:
        return os.environ.get("HERMES_PROFILE", "default")

    def register_tool(
        self,
        name: str,
        toolset: str,
        schema: dict[str, Any],
        handler: Callable[..., Any],
        check_fn: Callable[..., Any] | None = None,
        requires_env: list[str] | None = None,
        is_async: bool = False,
        description: str = "",
        emoji: str = "",
        **_: Any,
    ) -> None:
        self.tools.append(
            ToolRecord(
                name=name,
                toolset=toolset,
                schema=schema,
                handler=handler,
                check_fn=check_fn,
                requires_env=list(requires_env or []),
                is_async=is_async,
                description=description,
                emoji=emoji,
            )
        )

    def register_hook(self, hook_name: str, callback: Callable[..., Any]) -> None:
        self.hooks.append(HookRecord(hook_name, callback))

    def register_middleware(self, kind: str, callback: Callable[..., Any]) -> None:
        self.middleware.append(MiddlewareRecord(kind, callback))

    def register_command(
        self,
        name: str,
        handler: Callable[..., Any],
        description: str = "",
        args_hint: str = "",
    ) -> None:
        self.commands.append(CommandRecord(name.lstrip("/"), handler, description, args_hint))

    def register_cli_command(
        self,
        name: str,
        help: str,
        setup_fn: Callable[..., Any],
        handler_fn: Callable[..., Any] | None = None,
        description: str = "",
    ) -> None:
        self.cli_commands.append(
            CliCommandRecord(name, help, setup_fn, handler_fn, description or help)
        )

    def register_skill(self, name: str, path: Path, description: str = "") -> None:
        resolved = Path(path)
        if not resolved.is_absolute():
            resolved = self.plugin_dir / resolved
        resolved = resolved.resolve()
        try:
            resolved.relative_to(self.plugin_dir)
        except ValueError:
            self.unsupported.append(f"skill_outside_plugin:{name}")
            return
        self.skills.append(SkillRecord(name, resolved, description))

    def register_auxiliary_task(
        self,
        key: str,
        *,
        display_name: str = "",
        description: str = "",
        defaults: dict[str, Any] | None = None,
        **_: Any,
    ) -> None:
        self.auxiliary_tasks.append(
            AuxiliaryTaskRecord(
                key=key,
                display_name=display_name or key,
                description=description,
                defaults=dict(defaults or {}),
            )
        )

    def __getattr__(self, name: str) -> Callable[..., None]:
        if name.startswith("register_"):
            def recorder(*args: Any, **kwargs: Any) -> None:
                del kwargs
                label = name.removeprefix("register_")
                detail = getattr(args[0], "name", None) if args else None
                self.unsupported.append(f"{label}:{detail}" if detail else label)

            return recorder
        raise AttributeError(name)


def _plugin_dirs(install_dir: Path) -> list[Path]:
    if not install_dir.exists():
        return []
    if (install_dir / "plugin.yaml").is_file() and (install_dir / "__init__.py").is_file():
        return [install_dir]
    return [
        child
        for child in sorted(install_dir.iterdir())
        if child.is_dir()
        and (child / "plugin.yaml").is_file()
        and (child / "__init__.py").is_file()
    ]


def _load_plugin(plugin_dir: Path) -> tuple[dict[str, Any], RecordingContext]:
    cache_key = str(plugin_dir.resolve())
    cached = _PLUGIN_CACHE.get(cache_key)
    if cached is not None:
        return cached

    manifest = _load_yaml(plugin_dir / "plugin.yaml")
    key = plugin_dir.name
    ctx = RecordingContext(manifest, key, plugin_dir.resolve())

    parent = str(plugin_dir.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)

    parent_name = "openclaw_hermes_plugins"
    parent_module = sys.modules.get(parent_name)
    if parent_module is None:
        import types

        parent_module = types.ModuleType(parent_name)
        parent_module.__path__ = [str(plugin_dir.parent)]  # type: ignore[attr-defined]
        sys.modules[parent_name] = parent_module

    identity = hashlib.sha256(str(plugin_dir.resolve()).encode()).hexdigest()[:16]
    module_name = f"{parent_name}.plugin_{identity}"
    spec = importlib.util.spec_from_file_location(
        module_name,
        plugin_dir / "__init__.py",
        submodule_search_locations=[str(plugin_dir)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load plugin module at {plugin_dir}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        spec.loader.exec_module(module)

    register = getattr(module, "register", None)
    if not callable(register):
        raise RuntimeError("Plugin has no callable register(ctx)")
    with contextlib.redirect_stdout(stdout):
        register(ctx)
    printed = stdout.getvalue()
    if printed:
        print(printed, file=sys.stderr, end="")
    loaded = (manifest, ctx)
    _PLUGIN_CACHE[cache_key] = loaded
    return loaded


def _plugin_summary(plugin_dir: Path, manifest: dict[str, Any], ctx: RecordingContext) -> dict[str, Any]:
    return {
        "key": plugin_dir.name,
        "name": str(manifest.get("name") or plugin_dir.name),
        "version": str(manifest.get("version") or ""),
        "description": str(manifest.get("description") or ""),
        "path": str(plugin_dir),
        "tools": [tool.summary() for tool in ctx.tools],
        "hooks": sorted({hook.name for hook in ctx.hooks}),
        "middleware": sorted({middleware.kind for middleware in ctx.middleware}),
        "commands": sorted([command.summary() for command in ctx.commands], key=lambda item: item["name"]),
        "cliCommands": sorted([command.summary() for command in ctx.cli_commands], key=lambda item: item["name"]),
        "skills": sorted([skill.summary() for skill in ctx.skills], key=lambda item: item["name"]),
        "auxiliaryTasks": sorted(
            [task.summary() for task in ctx.auxiliary_tasks],
            key=lambda item: item["key"],
        ),
        "unsupported": sorted(set(ctx.unsupported)),
    }


def _summarize_plugin(plugin_dir: Path) -> dict[str, Any]:
    try:
        manifest, ctx = _load_plugin(plugin_dir)
        return _plugin_summary(plugin_dir, manifest, ctx)
    except Exception as exc:
        manifest = _load_yaml(plugin_dir / "plugin.yaml")
        empty = RecordingContext(manifest, plugin_dir.name, plugin_dir)
        return {**_plugin_summary(plugin_dir, manifest, empty), "error": f"{type(exc).__name__}: {exc}"}


def _list(payload: dict[str, Any]) -> dict[str, Any]:
    install_dir = Path(str(payload["installDir"])).expanduser().resolve()
    return {
        "installDir": str(install_dir),
        "plugins": [_summarize_plugin(plugin_dir) for plugin_dir in _plugin_dirs(install_dir)],
    }


def _matching_plugin_dirs(install_dir: Path, wanted_plugin: Any) -> list[Path]:
    plugin_dirs = _plugin_dirs(install_dir)
    if not wanted_plugin:
        return plugin_dirs

    selector = str(wanted_plugin)
    exact = [plugin_dir for plugin_dir in plugin_dirs if plugin_dir.name == selector]
    if exact:
        return exact

    aliases = []
    for plugin_dir in plugin_dirs:
        manifest = _load_yaml(plugin_dir / "plugin.yaml")
        if selector in {manifest.get("name"), manifest.get("key")}:
            aliases.append(plugin_dir)
    if len(aliases) > 1:
        names = ", ".join(plugin_dir.name for plugin_dir in aliases)
        raise RuntimeError(f"Plugin selector '{selector}' is ambiguous. Matches: {names}")
    return aliases


def _invoke(handler: Callable[..., Any], arg: Any) -> Any:
    positional = [
        param
        for param in inspect.signature(handler).parameters.values()
        if param.kind
        in {
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.VAR_POSITIONAL,
        }
    ]
    return _run_handler(handler, arg) if positional else _run_handler(handler)


def _run_handler(handler: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        result = handler(*args, **kwargs)
        if inspect.isawaitable(result):
            result = asyncio.run(result)
    printed = stdout.getvalue()
    if printed:
        print(printed, file=sys.stderr, end="")
    return result


def _invoke_event_callback(handler: Callable[..., Any], kwargs: dict[str, Any]) -> Any:
    params = list(inspect.signature(handler).parameters.values())
    if any(param.kind == inspect.Parameter.VAR_KEYWORD for param in params):
        return _run_handler(handler, **kwargs)

    if len(params) == 1:
        param = params[0]
        if param.default is inspect.Parameter.empty and (
            param.kind == inspect.Parameter.POSITIONAL_ONLY
            or (param.kind == inspect.Parameter.POSITIONAL_OR_KEYWORD and param.name not in kwargs)
        ):
            return _run_handler(handler, kwargs)

    keyword_names = {
        param.name for param in params
        if param.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
    }
    return _run_handler(handler, **{key: value for key, value in kwargs.items() if key in keyword_names})


Registration = TypeVar("Registration", ToolRecord, CommandRecord, CliCommandRecord, SkillRecord)


def _find_registration(
    payload: dict[str, Any],
    name: str,
    label: str,
    registrations: Callable[[RecordingContext], list[Registration]],
) -> tuple[Path, Registration]:
    wanted_plugin = payload.get("plugin")
    install_dir = Path(str(payload["installDir"])).expanduser().resolve()
    matches = []
    for plugin_dir in _matching_plugin_dirs(install_dir, wanted_plugin):
        _manifest, ctx = _load_plugin(plugin_dir)
        matches.extend((plugin_dir, entry) for entry in registrations(ctx) if entry.name == name)

    if not matches:
        raise RuntimeError(f"Plugin {label} not found: {name}")
    if len(matches) > 1 and not wanted_plugin:
        names = ", ".join(plugin_dir.name for plugin_dir, _ in matches)
        raise RuntimeError(f"Plugin {label} '{name}' is ambiguous. Specify plugin. Matches: {names}")
    return matches[0]


def _call(payload: dict[str, Any]) -> dict[str, Any]:
    wanted_tool = str(payload["tool"])
    plugin_dir, tool = _find_registration(payload, wanted_tool, "tool", lambda ctx: ctx.tools)
    if not tool.available():
        raise RuntimeError(f"Plugin tool '{wanted_tool}' is unavailable; check required env or check_fn.")

    args = payload.get("args")
    if not isinstance(args, dict):
        args = {}
    result = _invoke(tool.handler, args)

    response: dict[str, Any] = {
        "plugin": plugin_dir.name,
        "tool": tool.name,
        "result": _jsonable(result),
    }
    if isinstance(result, str):
        try:
            response["parsedResult"] = json.loads(result)
        except Exception:
            pass
    return response


def _command(payload: dict[str, Any]) -> dict[str, Any]:
    wanted_command = str(payload["command"]).lstrip("/")
    plugin_dir, command = _find_registration(payload, wanted_command, "command", lambda ctx: ctx.commands)
    if command.handler is None:
        raise RuntimeError(f"Plugin command '{wanted_command}' has no callable handler.")

    result = _invoke(command.handler, payload.get("args", ""))
    return {
        "plugin": plugin_dir.name,
        "command": command.name,
        "result": _jsonable(result),
    }


def _cli_command(payload: dict[str, Any]) -> dict[str, Any]:
    import argparse
    import shlex

    wanted_command = str(payload["command"]).lstrip("/")
    plugin_dir, command = _find_registration(payload, wanted_command, "CLI command", lambda ctx: ctx.cli_commands)
    raw_args = payload.get("args", [])
    argv = raw_args if isinstance(raw_args, list) else shlex.split(str(raw_args))

    parser = argparse.ArgumentParser(prog=f"openclaw hermes {plugin_dir.name} {command.name}")
    stdout = io.StringIO()
    stderr = io.StringIO()
    if command.setup_fn is not None:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            command.setup_fn(parser)
    if command.handler_fn is not None:
        parser.set_defaults(func=command.handler_fn)

    try:
        namespace = parser.parse_args([str(arg) for arg in argv])
    except SystemExit as exc:
        raise RuntimeError(f"Plugin CLI command parse failed with exit code {exc.code}") from exc

    handler = getattr(namespace, "func", None)
    if not callable(handler):
        raise RuntimeError(f"Plugin CLI command '{wanted_command}' has no callable handler.")

    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        result = handler(namespace)
    if inspect.isawaitable(result):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = asyncio.run(result)
    return {
        "plugin": plugin_dir.name,
        "command": command.name,
        "result": _jsonable(result),
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
    }


def _skill(payload: dict[str, Any]) -> dict[str, Any]:
    wanted_skill = str(payload["skill"])
    plugin_dir, skill = _find_registration(payload, wanted_skill, "skill", lambda ctx: ctx.skills)
    return {
        "plugin": plugin_dir.name,
        "skill": skill.name,
        "description": skill.description,
        "text": skill.read_text(),
    }


def _event_kwargs(payload: dict[str, Any]) -> dict[str, Any]:
    kwargs = payload.get("kwargs")
    if not isinstance(kwargs, dict):
        kwargs = {}
    context = payload.get("context")
    if isinstance(context, dict):
        return {**context, **kwargs, "openclaw_context": context}
    return kwargs


def _hook(payload: dict[str, Any]) -> dict[str, Any]:
    hook_name = str(payload["hook"])
    kwargs = _event_kwargs(payload)

    results: list[Any] = []
    invoked: list[dict[str, str]] = []
    for plugin_dir in _plugin_dirs(Path(str(payload["installDir"])).expanduser().resolve()):
        _manifest, ctx = _load_plugin(plugin_dir)
        for hook in ctx.hooks:
            if hook.name != hook_name:
                continue
            invoked.append({"plugin": plugin_dir.name, "hook": hook.name})
            try:
                result = _invoke_event_callback(hook.callback, kwargs)
            except Exception as exc:
                if hook_name == "pre_tool_call":
                    raise
                print(f"Hook '{hook.name}' callback failed: {exc}", file=sys.stderr)
                continue
            if result is not None:
                results.append(_jsonable(result))
    return {"hook": hook_name, "invoked": invoked, "results": results}


def _middleware(payload: dict[str, Any]) -> dict[str, Any]:
    kind = str(payload["kind"])
    kwargs = _event_kwargs(payload)

    results: list[Any] = []
    invoked: list[dict[str, str]] = []
    field = {"tool_request": "args", "llm_request": "request"}.get(kind)
    original = kwargs.get(field) if field else None
    original = original if isinstance(original, dict) else {}
    current = dict(original)
    changed = False
    for plugin_dir in _plugin_dirs(Path(str(payload["installDir"])).expanduser().resolve()):
        _manifest, ctx = _load_plugin(plugin_dir)
        for middleware in ctx.middleware:
            if middleware.kind != kind:
                continue
            invoked.append({"plugin": plugin_dir.name, "middleware": middleware.kind})
            callback_kwargs = {**kwargs, field: current, f"original_{field}": original} if field else kwargs
            try:
                result = _invoke_event_callback(middleware.callback, callback_kwargs)
            except Exception as exc:
                if kind == "tool_request":
                    raise
                print(f"Middleware '{middleware.kind}' callback failed: {exc}", file=sys.stderr)
                continue
            if result is not None:
                json_result = _jsonable(result)
                results.append(json_result)
                update = json_result.get(field) if field and isinstance(json_result, dict) else None
                if isinstance(update, dict):
                    current = dict(update)
                    changed = True
    if changed:
        results = [{field: current}]
    return {"middleware": kind, "invoked": invoked, "results": results}


def _dispatch(payload: dict[str, Any]) -> Any:
    op = payload.get("op")
    if op == "list":
        return _list(payload)
    if op == "call":
        return _call(payload)
    if op == "command":
        return _command(payload)
    if op == "cliCommand":
        return _cli_command(payload)
    if op == "skill":
        return _skill(payload)
    if op == "hook":
        return _hook(payload)
    if op == "middleware":
        return _middleware(payload)
    raise RuntimeError(f"Unknown operation: {op}")


def main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id: Any = None
        try:
            payload = json.loads(line)
            request_id = payload.pop("requestId", None)
            response = {"requestId": request_id, "result": _dispatch(payload)}
        except Exception as exc:
            response = {"requestId": request_id, "error": f"{type(exc).__name__}: {exc}"}
            if os.environ.get("OPENCLAW_HERMES_PLUGIN_DEBUG"):
                traceback.print_exc(file=sys.stderr)
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
