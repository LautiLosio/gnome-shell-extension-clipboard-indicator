import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('history',Path(__file__).parents[1]/'history_service.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.archive=module.Archive(Path(self.temp.name)/'archive')
    def tearDown(self):
        self.archive.db.close()
        self.temp.cleanup()
    def add(self,text):
        return self.archive.dispatch({'op':'add','mimetype':'text/plain','data':base64.b64encode(text.encode()).decode()})['id']
    def test_deduplication_and_restart(self):
        a=self.add('example')
        self.assertEqual(a,self.add('example'))
        self.archive.db.close()
        self.archive=module.Archive(Path(self.temp.name)/'archive')
        self.assertEqual(len(self.archive.query()['items']),1)
    def test_search_tags_edits_and_delete(self):
        a=self.add('network repair')
        self.archive.dispatch({'op':'update','entry':a,'tag':'router'})
        self.assertEqual(self.archive.query('rout')['items'][0]['id'],a)
        self.archive.dispatch({'op':'update','entry':a,'text':'audio repair'})
        self.assertFalse(self.archive.query('network')['items'])
        self.archive.dispatch({'op':'delete','entry':a})
        self.assertFalse(self.archive.query('audio')['items'])
    def test_bounded_pages_and_pins(self):
        for i in range(103): self.add(f'entry {i}')
        self.archive.dispatch({'op':'update','entry':1,'favorite':True})
        page=self.archive.query()
        self.assertEqual(len(page['items']),30)
        self.assertTrue(page['more'])
        self.assertEqual(page['total'],103)
        self.assertEqual(len(self.archive.query(limit=60)['items']),60)
        self.assertEqual(page['items'][0]['id'],1)
        ids=[]
        for offset in range(0,120,30): ids.extend(x['id'] for x in self.archive.query(offset=offset)['items'])
        self.assertEqual(len(set(ids)),103)
        self.archive.dispatch({'op':'clear'})
        self.assertEqual(len(self.archive.query()['items']),1)
    def test_image_payload_and_delete(self):
        payload=b'original image bytes'
        a=self.archive.dispatch({'op':'add','mimetype':'image/png','data':base64.b64encode(payload).decode()})['id']
        self.assertEqual(base64.b64decode(self.archive.dispatch({'op':'get','entry':a})['data']),payload)
        self.archive.dispatch({'op':'delete','entry':a})
        self.assertFalse(list(self.archive.attachments.iterdir()))
    def test_import_idempotent_and_source_preserved(self):
        source=Path(self.temp.name)/'legacy.json'
        content=json.dumps([{'contents':'old data','favorite':True,'tag':'archive'}])
        source.write_text(content)
        self.archive.import_legacy(source)
        self.archive.import_legacy(source)
        self.assertEqual(len(self.archive.query()['items']),1)
        self.assertEqual(source.read_text(),content)
    def test_failed_import_rolls_back(self):
        source=Path(self.temp.name)/'bad.json'
        source.write_text(json.dumps([{'contents':'valid'},{'mimetype':'image/png','contents':'/missing.png'}]))
        with self.assertRaises(FileNotFoundError): self.archive.import_legacy(source)
        self.assertEqual(len(self.archive.query()['items']),0)
    def test_import_duplicate_preserves_pin(self):
        source=Path(self.temp.name)/'duplicates.json'
        source.write_text(json.dumps([{'contents':'same'},{'contents':'same','favorite':True,'tag':'important'}]))
        self.archive.import_legacy(source)
        items=self.archive.query()['items']
        self.assertEqual(len(items),1)
        self.assertTrue(items[0]['favorite'])
        self.assertEqual(items[0]['tag'],'important')
    def test_cycle_and_pin_order(self):
        for text in ['first','second','third']: self.add(text)
        newest=self.archive.query()['items'][0]['id']
        neighbor=self.archive.dispatch({'op':'cycle','entry':newest,'direction':1})
        self.assertNotEqual(neighbor['id'],newest)
        back=self.archive.dispatch({'op':'cycle','entry':neighbor['id'],'direction':-1})
        self.assertEqual(back['id'],newest)

    def test_search_punctuation_is_safe(self):
        self.add('https://example.com/hello?q=1')
        self.assertTrue(self.archive.query('example.com')['items'])
        self.archive.query('" OR * -')

if __name__=='__main__': unittest.main()
