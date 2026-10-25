"""Merge interface for the manifest loader and the existing phone-runtime factory."""
from copy import deepcopy


def select_transport(selection, legacy, package):
    """The loader's gateway selection is the only switch; existing provider/model/secret config is reused."""
    if "phone" not in selection.get("gateway", []):
        return legacy
    if legacy is None:
        return None
    entry = deepcopy(package)
    entry["command"] = legacy["command"]
    entry["env"] = {**legacy.get("env", {}), **entry.get("env", {})}
    return {**legacy, **entry}
