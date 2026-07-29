from abc import ABC, abstractmethod
from typing import Any, Optional


class BaseObject(ABC):
    """
    Abstract Base Class for all timeline objects (Audio, Video, Modulators, etc.).
    Enforces a consistent rendering interface and internal data container.
    """

    def __init__(self, name: str = "BaseObject", data: Optional[Any] = None) -> None:
        self.name = name
        self._data: Any = data if data is not None else {}

    @property
    def data(self) -> Any:
        """Internal data container property."""
        return self._data

    @data.setter
    def data(self, value: Any) -> None:
        self._data = value

    @abstractmethod
    def render(self, **kwargs: Any) -> Any:
        """
        Enforces case-specific rendering for inheriting classes (Audio, Video, Modulators, etc.).
        """
        pass
