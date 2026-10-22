#!/usr/bin/env python3
"""Synthetic archive benchmark; never touches personal clipboard history."""
import importlib.util
import json
from pathlib import Path
import statistics
import tempfile
import time

spec=importlib.util.spec_from_file_location('history',Path(__file__).parents[1]/'history_service.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
results=[]
for count in [1000,10000,100000]:
    with tempfile.TemporaryDirectory() as folder:
        archive=module.Archive(folder)
        start=time.perf_counter()
        with archive.db:
            for i in range(count):
                archive.add('text/plain',f'Entry {i}: https://example.org/{i} Linux audio network development notes category{i%113}'.encode(),i%137==0)
        seeded=time.perf_counter()-start
        timings={}
        for name,args in [('recent',{}),('keyword',{'q':'category17'}),('broad',{'q':'Entry'})]:
            durations=[]
            for _ in range(31):
                start=time.perf_counter();reply=archive.query(**args);durations.append((time.perf_counter()-start)*1000)
                assert len(reply['items'])<=30
            timings[name]={'median_ms':round(statistics.median(durations),2),'p95_ms':round(sorted(durations)[29],2)}
        results.append({'entries':count,'seed_seconds':round(seeded,2),'queries':timings,'max_rows':30})
        archive.db.close()
print(json.dumps({'scope':'SQLite helper only; not GNOME frame or popup timings','results':results},indent=2))
