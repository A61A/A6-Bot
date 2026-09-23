import sqlite3
conn = sqlite3.connect(r'C:\Users\itrap\Documents\a6 bot\data\nodeline.db')
c = conn.cursor()
c.execute('SELECT name FROM sqlite_master WHERE type="table"')
for row in c.fetchall():
    print(row)
c.execute('PRAGMA table_info(delivery_items)')
for row in c.fetchall():
    print(row)