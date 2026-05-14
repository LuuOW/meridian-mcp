# mlcore/ane_encoder — convert + verify a tiny ANE-shaped encoder.
PY := .venv/bin/python

.PHONY: venv convert compile verify test clean tiny

# Default target: realistic preset (proves runtime placement on ANE).
# Override with `make tiny` for the fast dev-loop preset.
PRESET ?= realistic

venv:
	python3 -m venv .venv
	.venv/bin/pip install -U pip wheel
	.venv/bin/pip install -r requirements.txt

convert:
	ANE_PRESET=$(PRESET) $(PY) convert.py

compile: convert
	xcrun coremlcompiler compile build/AneEncoder.mlpackage build/

verify: compile
	ANE_PRESET=$(PRESET) $(PY) verify_all.py build/AneEncoder.mlpackage

# Convenience: tiny preset (fast convert, proves recipe; CPU-preferred at runtime)
tiny:
	$(MAKE) verify PRESET=tiny

test: verify

clean:
	rm -rf build/AneEncoder.mlpackage build/AneEncoder.mlmodelc build/proof __pycache__
