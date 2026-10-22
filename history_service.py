#!/usr/bin/env python3
"""Local archive. JSON lines over private subprocess pipes; stdout is protocol only."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import io
from pathlib import Path
import re
import sqlite3
import sys
import subprocess
import threading
import time


class Archive:
    def __init__(self, root, legacy=None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        self.attachments = self.root / 'attachments'
        self.attachments.mkdir(exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(self.root / 'history.sqlite3', timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS entries(
                id INTEGER PRIMARY KEY, digest TEXT UNIQUE, mimetype TEXT NOT NULL,
                text TEXT NOT NULL DEFAULT '', path TEXT, favorite INTEGER NOT NULL DEFAULT 0,
                tag TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, used INTEGER NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1, thumbnail TEXT, processed INTEGER NOT NULL DEFAULT 0);
            CREATE INDEX IF NOT EXISTS entries_order ON entries(favorite DESC, used DESC, id DESC);
            CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(text, tag, tokenize='unicode61');
            CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
                INSERT INTO search(rowid,text,tag) VALUES(new.id,new.text,new.tag); END;
            CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
                DELETE FROM search WHERE rowid=old.id; END;
            CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE OF text,tag ON entries BEGIN
                DELETE FROM search WHERE rowid=old.id;
                INSERT INTO search(rowid,text,tag) VALUES(new.id,new.text,new.tag); END;
            CREATE TABLE IF NOT EXISTS vectors(id INTEGER PRIMARY KEY, revision INTEGER, vector BLOB);
            CREATE TRIGGER IF NOT EXISTS vectors_ad AFTER DELETE ON entries BEGIN
                DELETE FROM vectors WHERE id=old.id; END;
        ''')
        columns = {r[1] for r in self.db.execute('PRAGMA table_info(entries)')}
        for name, definition in [('thumbnail','TEXT'),('processed','INTEGER NOT NULL DEFAULT 0')]:
            if name not in columns:
                self.db.execute(f'ALTER TABLE entries ADD COLUMN {name} {definition}')
        self.search_cache = {}
        self.semantic = None
        self.semantic_status = 'not installed'
        self.stop = threading.Event()
        if legacy:
            self.import_legacy(Path(legacy))

    def import_legacy(self, filename):
        if self.db.execute("SELECT 1 FROM meta WHERE key='legacy-import'").fetchone():
            return
        if not filename.exists():
            return
        data = json.loads(filename.read_text())
        # One transaction makes a failed import retryable. Source files are never modified.
        with self.db:
            for i, entry in enumerate(data):
                mime = entry.get('mimetype', 'text/plain;charset=utf-8')
                content = entry.get('contents', '')
                payload = content.encode() if self.is_text(mime) else Path(content).read_bytes()
                self.add(mime, payload, entry.get('favorite', False), entry.get('tag', ''), i + 1)
            self.db.execute("INSERT INTO meta VALUES('legacy-import',?)", (str(filename),))

    @staticmethod
    def is_text(mime):
        return mime.startswith('text/') or mime in ('STRING', 'UTF8_STRING')

    def add(self, mime, payload, favorite=False, tag='', stamp=None):
        digest = hashlib.sha256(mime.encode() + b'\0' + payload).hexdigest()
        stamp = stamp if stamp is not None else time.time_ns() // 1000
        existing = self.db.execute('SELECT id FROM entries WHERE digest=?', (digest,)).fetchone()
        if existing:
            self.db.execute('UPDATE entries SET used=? WHERE id=?', (stamp, existing['id']))
            if favorite or tag:
                self.db.execute("UPDATE entries SET favorite=max(favorite,?),tag=CASE WHEN ?<>'' THEN ? ELSE tag END WHERE id=?",
                                (int(favorite),tag,tag,existing['id']))
            return existing['id']
        text, path = '', None
        if self.is_text(mime):
            text = payload.decode('utf-8', errors='replace')
        elif mime.startswith('image/'):
            file = self.attachments / digest
            temporary = file.with_suffix('.tmp')
            temporary.write_bytes(payload)
            os.chmod(temporary, 0o600)
            temporary.replace(file)
            path = str(file)
        else:
            raise ValueError('Unsupported clipboard format')
        return self.db.execute('''INSERT INTO entries(digest,mimetype,text,path,favorite,tag,created,used)
            VALUES(?,?,?,?,?,?,?,?)''', (digest,mime,text,path,int(favorite),tag,stamp,stamp)).lastrowid

    def query(self, q='', limit=30, offset=0, semantic=False, case_sensitive=False, regex=False, pinned_bottom=False):
        limit = max(1, min(int(limit), 90))
        offset = max(0, int(offset))
        if regex:
            try:
                completed=subprocess.run([sys.executable,__file__,'--regex',str(self.root/'history.sqlite3'),q,str(limit),str(offset),str(int(case_sensitive)),str(int(pinned_bottom))],capture_output=True,text=True,timeout=1)
            except subprocess.TimeoutExpired: raise ValueError('Regex search exceeded its one-second limit')
            if completed.returncode: raise ValueError('Invalid regular expression')
            return json.loads(completed.stdout)
        pin_order='ASC' if pinned_bottom else 'DESC'
        fields = "e.id,e.mimetype,substr(e.text,1,180) AS preview,e.favorite,substr(e.tag,1,80) AS tag,e.used,e.thumbnail"
        tokens = re.findall(r'\w+', q, re.UNICODE)[:64]
        args = []
        if case_sensitive and q:
            source,where,order='entries e',' WHERE instr(e.text,?)>0 OR instr(e.tag,?)>0',f'e.favorite {pin_order},e.used DESC,e.id DESC'
            args=[q,q]
        elif tokens:
            match = ' AND '.join('"' + t.replace('"','""') + '"*' for t in tokens)
            source = 'search JOIN entries e ON e.id=search.rowid'
            where = ' WHERE search MATCH ?'
            args.append(match)
            order = f'e.favorite {pin_order},rank,e.used DESC,e.id DESC'
        else:
            source, where, order = 'entries e', '', f'e.favorite {pin_order},e.used DESC,e.id DESC'
        rows = [dict(r) for r in self.db.execute(f'SELECT {fields} FROM {source}{where} ORDER BY {order} LIMIT ? OFFSET ?', (*args,limit+1,offset))]
        more = len(rows) > limit
        rows = rows[:limit]
        total = self.db.execute(f'SELECT count(*) FROM {source}{where}',args).fetchone()[0]
        cache_key=(q,case_sensitive,pinned_bottom)
        if semantic and q and self.semantic is not None:
            if offset == 0 or cache_key not in self.search_cache:
                # Model inference and vector scan run in the helper, never Shell.
                import numpy as np
                vector = next(self.semantic.query_embed(q)).astype(np.float32)
                scores = []
                cursor = self.db.execute('SELECT v.id,v.vector FROM vectors v JOIN entries e ON e.id=v.id AND e.revision=v.revision')
                while batch := cursor.fetchmany(512):
                    matrix = np.stack([np.frombuffer(r['vector'], dtype=np.float32) for r in batch])
                    similarity = matrix @ vector
                    scores.extend((float(score), r['id']) for score,r in zip(similarity,batch) if score >= 0.25)
                scores.sort(reverse=True)
                matches = self.db.execute(f'SELECT e.id FROM {source}{where} ORDER BY {order}', args)
                lexical = {r['id']: 1/(60+i) for i,r in enumerate(matches)}
                for i,(_,ident) in enumerate(scores):
                    lexical[ident] = lexical.get(ident,0) + 1/(60+i)
                ids = sorted(lexical, key=lexical.get, reverse=True)
                pinned={r[0] for r in self.db.execute('SELECT id FROM entries WHERE favorite=1')}
                ids.sort(key=lambda ident: (ident in pinned) if pinned_bottom else (ident not in pinned))
                self.search_cache.clear()
                self.search_cache[cache_key] = ids
            ids = self.search_cache.get(cache_key, [])
            total = len(ids)
            rows = []
            for ident in ids[offset:offset+limit]:
                row = self.db.execute(f'SELECT {fields} FROM entries e WHERE id=?',(ident,)).fetchone()
                if row: rows.append(dict(row))
            more = offset+limit < total
        return {'items': rows, 'more':more, 'total':total, 'semantic':self.semantic_status}

    def start_assets(self):
        def worker():
            conn = sqlite3.connect(self.root/'history.sqlite3', timeout=10)
            conn.row_factory = sqlite3.Row
            ocr = None
            try:
                from rapidocr import RapidOCR
                ocr = RapidOCR(params={"EngineConfig.onnxruntime.intra_op_num_threads": 2,
                                       "EngineConfig.onnxruntime.inter_op_num_threads": 1})
            except ImportError:
                pass
            except Exception as error:
                print('OCR unavailable: '+str(error), file=sys.stderr)
            while not self.stop.is_set():
                row = conn.execute("SELECT id,path FROM entries WHERE path IS NOT NULL AND processed=0 LIMIT 1").fetchone()
                if row is None:
                    self.stop.wait(2)
                    continue
                thumbnail = None
                text = ''
                try:
                    from PIL import Image
                    with Image.open(row['path']) as image:
                        image.thumbnail((96,96))
                        file = Path(row['path']+'.thumb.png')
                        image.convert('RGB').save(file,format='PNG')
                        thumbnail = str(file)
                    if ocr:
                        result = ocr(row['path'])
                        text = '\n'.join(result.txts or [])
                except Exception as error:
                    print('Image indexing failed: '+str(error), file=sys.stderr)
                with conn:
                    conn.execute('UPDATE entries SET thumbnail=?,text=?,processed=1,revision=revision+1 WHERE id=?',
                                 (thumbnail,text,row['id']))
                    retained = conn.execute('SELECT 1 FROM entries WHERE id=?',(row['id'],)).fetchone()
                if not retained and thumbnail:
                    Path(thumbnail).unlink(missing_ok=True)
            conn.close()
        threading.Thread(target=worker,daemon=True).start()

    def start_semantic(self):
        def worker():
            try:
                from fastembed import TextEmbedding
                self.semantic_status = 'loading local model'
                model = TextEmbedding(model_name='sentence-transformers/all-MiniLM-L6-v2',
                                      cache_dir=str(self.root/'models'), threads=2, local_files_only=True)
                # Force initialization before making it available for queries.
                list(model.embed(['clipboard']))
                conn = sqlite3.connect(self.root/'history.sqlite3', timeout=10)
                conn.row_factory = sqlite3.Row
                self.semantic = model
                while not self.stop.is_set():
                    rows = conn.execute('''SELECT e.id,e.revision,substr(e.text,1,6000) text,e.tag FROM entries e
                        LEFT JOIN vectors v ON v.id=e.id
                        WHERE (e.text<>'' OR e.tag<>'') AND (v.id IS NULL OR v.revision<>e.revision) LIMIT 16''').fetchall()
                    self.semantic_status = 'indexing' if rows else 'ready'
                    if not rows:
                        self.stop.wait(2)
                        continue
                    vectors = model.passage_embed([r['text']+'\n'+r['tag'] for r in rows])
                    for row,vec in zip(rows,vectors):
                        if self.stop.is_set(): break
                        with conn:
                            conn.execute('''INSERT OR REPLACE INTO vectors SELECT id,revision,? FROM entries
                                WHERE id=? AND revision=?''', (vec.astype('float32').tobytes(),row['id'],row['revision']))
                conn.close()
            except ImportError:
                self.semantic_status = 'not installed'
            except Exception as error:
                self.semantic_status = 'unavailable'
                print('Semantic indexing failed: '+str(error), file=sys.stderr)
        threading.Thread(target=worker,daemon=True).start()

    def dispatch(self, request):
        op = request['op']
        if op == 'query': return self.query(**{k:v for k,v in request.items() if k in ('q','limit','offset','semantic','case_sensitive','regex','pinned_bottom')})
        if op == 'cycle':
            sign=-1 if request.get('pinned_bottom') else 1
            current = self.db.execute(f'SELECT {sign}*favorite AS favorite,used,id FROM entries WHERE id=?',(request.get('entry'),)).fetchone()
            forward = request.get('direction',1) > 0
            comparison,order = ('<','DESC') if forward else ('>','ASC')
            row = None
            if current:
                row = self.db.execute(f'SELECT id FROM entries WHERE ({sign}*favorite,used,id){comparison}(?,?,?) ORDER BY {sign}*favorite {order},used {order},id {order} LIMIT 1',tuple(current)).fetchone()
            if row is None:
                row = self.db.execute(f'SELECT id FROM entries ORDER BY {sign}*favorite {order},used {order},id {order} LIMIT 1').fetchone()
            return dict(row) if row else None
        if op == 'stats':
            rows=self.db.execute('SELECT path,length(CAST(text AS BLOB)) size FROM entries').fetchall()
            content=sum((Path(r['path']).stat().st_size if Path(r['path']).exists() else 0) if r['path'] else r['size'] for r in rows)
            attachments=sum(p.stat().st_size for p in self.attachments.rglob('*') if p.is_file())
            database=sum(p.stat().st_size for p in self.root.glob('history.sqlite3*') if p.is_file())
            def directory_bytes(name):
                return sum(p.stat().st_size for p in (self.root/name).rglob('*') if p.is_file())
            return {'count':len(rows),'bytes':database+attachments,'content_bytes':content,
                    'archive_bytes':database+attachments,'database_bytes':database,'attachment_bytes':attachments,
                    'runtime_bytes':directory_bytes('runtime'),'model_bytes':directory_bytes('models'),
                    'semantic':self.semantic_status}
        with self.db:
            if op == 'add':
                ident=self.add(request['mimetype'],base64.b64decode(request['data'],validate=True))
                maximum=max(0,int(request.get('maximum',0)))
                if maximum:
                    self._delete('favorite=0 AND id NOT IN (SELECT id FROM entries WHERE favorite=0 ORDER BY used DESC,id DESC LIMIT ?)',(maximum,))
                return {'id':ident}
            if op == 'file':
                row = self.db.execute('SELECT path FROM entries WHERE id=?',(request['entry'],)).fetchone()
                if not row or not row['path']: raise ValueError('Entry is not an image')
                return {'uri':Path(row['path']).as_uri()}
            if op == 'preview':
                row = self.db.execute('SELECT text,path,tag,mimetype FROM entries WHERE id=?',(request['entry'],)).fetchone()
                if row is None: raise ValueError('Entry no longer exists')
                if not row['path']:
                    return {'text':row['text'][:4000], 'truncated':len(row['text'])>4000}
                from PIL import Image
                preview = Path(row['path']+'.preview.png')
                if not preview.exists():
                    with Image.open(row['path']) as image:
                        image.thumbnail((384,256))
                        temporary=Path(str(preview)+'.tmp')
                        image.convert('RGBA').save(temporary,format='PNG')
                        temporary.replace(preview)
                with Image.open(preview) as image: width,height=image.size
                return {'image':str(preview),'width':width,'height':height}
            if op == 'summary':
                row = self.db.execute('SELECT substr(text,1,100) text,mimetype,thumbnail FROM entries WHERE id=?',(request['entry'],)).fetchone()
                return dict(row) if row else None
            if op == 'touch':
                self.db.execute('UPDATE entries SET used=? WHERE id=?',(time.time_ns()//1000,request['entry']))
                return {}
            if op == 'get':
                row = self.db.execute('SELECT * FROM entries WHERE id=?',(request['entry'],)).fetchone()
                if row is None: raise ValueError('Entry no longer exists')
                data = row['text'].encode() if self.is_text(row['mimetype']) else Path(row['path']).read_bytes()
                return {'mimetype':row['mimetype'],'data':base64.b64encode(data).decode()}
            if op == 'update':
                ident = request['entry']
                row = self.db.execute('SELECT * FROM entries WHERE id=?',(ident,)).fetchone()
                if row is None: raise ValueError('Entry no longer exists')
                if 'favorite' in request: self.db.execute('UPDATE entries SET favorite=? WHERE id=?',(int(request['favorite']),ident))
                if 'tag' in request: self.db.execute('UPDATE entries SET tag=?,revision=revision+1 WHERE id=?',(request['tag'],ident))
                if 'text' in request:
                    if not self.is_text(row['mimetype']): raise ValueError('Only text can be edited')
                    text = request['text']
                    digest = hashlib.sha256(row['mimetype'].encode()+b'\0'+text.encode()).hexdigest()
                    self.db.execute('UPDATE entries SET text=?,digest=?,revision=revision+1 WHERE id=?',(text,digest,ident))
                return {}
            if op == 'delete':
                self._delete('id=?',(request['entry'],))
                return {}
            if op == 'clear':
                self._delete('favorite=0 AND id<>?',(request.get('keep') or -1,))
                return {}
        raise ValueError('Unknown operation')

    def _delete(self, where, args):
        paths = [p for r in self.db.execute('SELECT path,thumbnail FROM entries WHERE '+where,args) for p in r if p]
        self.db.execute('DELETE FROM entries WHERE '+where,args)
        # Commit first. A crash can leave an orphan file, never a missing retained payload.
        self.db.commit()
        for path in paths:
            Path(path).unlink(missing_ok=True)
            Path(path+'.preview.png').unlink(missing_ok=True)


def regex_query():
    database,q,limit,offset,sensitive,pinned_bottom=sys.argv[2:]
    pattern=re.compile(q,0 if sensitive=='1' else re.IGNORECASE)
    db=sqlite3.connect('file:'+database+'?mode=ro',uri=True)
    db.row_factory=sqlite3.Row
    order='ASC' if pinned_bottom=='1' else 'DESC'
    items=[]
    count=0
    for row in db.execute(f'SELECT id,mimetype,text,favorite,tag,used,thumbnail FROM entries ORDER BY favorite {order},used DESC,id DESC'):
        if pattern.search(row['text']) or pattern.search(row['tag']):
            if int(offset)<=count<int(offset)+int(limit):
                item=dict(row);item['preview']=item.pop('text')[:180];items.append(item)
            count+=1
    print(json.dumps({'items':items,'more':count>int(offset)+int(limit),'total':count,'semantic':'regex'}))


def main():
    os.umask(0o077)
    protocol = sys.stdout
    sys.stdout = sys.stderr  # Third-party model logs cannot corrupt protocol replies.
    archive = Archive(sys.argv[1], sys.argv[2] if len(sys.argv)>2 else None)
    archive.start_semantic()
    archive.start_assets()
    output_lock = threading.Lock()
    executor = ThreadPoolExecutor(max_workers=1)

    def answer(request, semantic=False):
        connection = None
        try:
            target = archive
            if semantic:
                # Each search worker owns its SQLite connection. Capture and lexical
                # requests keep running while semantic inference scans the archive.
                target = object.__new__(Archive)
                target.root = archive.root
                target.db = sqlite3.connect(archive.root/'history.sqlite3', timeout=10)
                target.db.row_factory = sqlite3.Row
                connection = target.db
                target.search_cache = archive.search_cache
                target.semantic = archive.semantic
                target.semantic_status = archive.semantic_status
            result = {'id':request['id'],'result':target.dispatch(request)}
            if request.get('op') in ('add','update','delete','clear','touch'):
                archive.search_cache.clear()
        except Exception as error:
            result = {'id':request.get('id'),'error':str(error)}
        finally:
            if connection: connection.close()
        with output_lock:
            print(json.dumps(result,ensure_ascii=True),file=protocol,flush=True)

    for line in sys.stdin:
        try:
            request = json.loads(line)
        except Exception:
            with output_lock:
                print(json.dumps({'id':None,'error':'Invalid request'}),file=protocol,flush=True)
            continue
        if request.get('op') == 'query' and request.get('semantic'):
            executor.submit(answer,request,True)
        else:
            answer(request)
    executor.shutdown(wait=True)
    archive.stop.set()


if __name__ == '__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--regex': regex_query()
    else: main()
