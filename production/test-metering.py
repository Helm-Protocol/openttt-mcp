#!/usr/bin/env python3
import importlib.util,sqlite3
from pathlib import Path
p=Path(__file__).with_name('metering.py');spec=importlib.util.spec_from_file_location('metering',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
db=sqlite3.connect(':memory:');db.execute('CREATE TABLE usage(hour INTEGER PRIMARY KEY,quantity INTEGER,reported INTEGER DEFAULT 0)')
for h,q in [(10,3),(11,2),(12,7),(1,9)]:db.execute('INSERT INTO usage VALUES (?,?,0)',(h,q))
db.commit();seen=[]
def failure(h,q):seen.append((h,q));raise RuntimeError('network')
try:m.flush(db,12*3600+5,failure)
except RuntimeError:pass
assert db.execute('SELECT sum(reported) FROM usage').fetchone()[0]==0
m.flush(db,12*3600+5,lambda h,q:seen.append((h,q)))
assert seen==[(10,3),(10,3),(11,2)]
assert db.execute('SELECT reported FROM usage WHERE hour=12').fetchone()[0]==0
assert db.execute('SELECT quantity FROM usage WHERE hour=1').fetchone()[0]==9
m.flush(db,12*3600+10,lambda h,q:seen.append((h,q)))
assert len(seen)==3
print('PASS: immutable closed-hour retry, current-hour exclusion, expired retention, no duplicate accepted report')
