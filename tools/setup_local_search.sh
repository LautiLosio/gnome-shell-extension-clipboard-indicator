#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
archive_root="${XDG_DATA_HOME:-$HOME/.local/share}/clipboard-indicator@lautilosio.github.io"
python3 -m venv "$archive_root/runtime"
"$archive_root/runtime/bin/python" -m pip install -r requirements-local.txt
"$archive_root/runtime/bin/python" - "$archive_root/models" <<'PY'
import sys
from fastembed import TextEmbedding
from rapidocr import RapidOCR
model=TextEmbedding(model_name='sentence-transformers/all-MiniLM-L6-v2',cache_dir=sys.argv[1],threads=2)
list(model.embed(['Initialize local search']))
RapidOCR(params={'EngineConfig.onnxruntime.intra_op_num_threads':2,'EngineConfig.onnxruntime.inter_op_num_threads':1})
print('Local search is ready. Clipboard contents are not uploaded.')
PY
