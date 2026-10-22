import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'recipes'))
from bridge import search_inventory
from search import RecipeSearch
from normalizer import ru_key


class ExpiryPriorityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'recipes.sqlite'
        con = sqlite3.connect(self.path)
        con.executescript('''CREATE TABLE recipes(id INTEGER PRIMARY KEY,language TEXT,title TEXT,source_url TEXT,
            dataset TEXT,ingredients_json TEXT,instructions_json TEXT,requirements_json TEXT,
            required_count INTEGER,has_instructions INTEGER,fingerprint TEXT);
          CREATE TABLE products(id INTEGER PRIMARY KEY,name TEXT,stable_key TEXT,localized INTEGER,recipe_count INTEGER);
          CREATE TABLE aliases(alias TEXT,language TEXT,product_id INTEGER);
          CREATE TABLE recipe_product(product_id INTEGER,recipe_id INTEGER,group_index INTEGER,optional INTEGER);
          CREATE INDEX lookup ON recipe_product(product_id,recipe_id);''')
        for pid, name in [(1, 'яйцо'), (2, 'рис'), (3, 'молоко')]:
            con.execute('INSERT INTO products VALUES (?,?,?,?,?)', (pid, name, 'known:' + name, 1, 1))
            con.execute('INSERT INTO aliases VALUES (?,?,?)', (ru_key(name), 'ru', pid))
        for rid in range(1, 201):
            self.add_recipe(con, rid, [[0, [1], 0], [1, [2], 0]], ['яйцо', 'рис'])
        self.add_recipe(con, 1000, [[0, [3], 0]], ['молоко'])
        self.add_recipe(con, 1001, [[0, [1], 0], [1, [3], 1]], ['яйцо', 'молоко по желанию'])
        con.commit(); con.close()
        self.engine = RecipeSearch(self.path)
        self.inventory = [
            {'id': 'eggs', 'name': 'яйца', 'deadline': '2026-10-25T20:00:00.000Z'},
            {'id': 'rice', 'name': 'рис', 'deadline': '2026-10-26T20:00:00.000Z'},
            {'id': 'milk-later', 'name': 'молоко', 'deadline': '2026-10-28T20:00:00.000Z'},
            {'id': 'milk-first', 'name': 'молоко', 'deadline': '2026-10-22T20:00:00.000Z'},
        ]

    def tearDown(self):
        self.temp.cleanup()

    def add_recipe(self, con, rid, requirements, ingredients):
        con.execute('INSERT INTO recipes VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            (rid, 'ru', str(rid), 'https://example.org/', 'fixture', json.dumps(ingredients),
             json.dumps(['Готовить']), json.dumps(requirements), sum(not r[2] for r in requirements), 1, str(rid)))
        for gi, (_, options, optional) in enumerate(requirements):
            for pid in options:
                con.execute('INSERT INTO recipe_product VALUES (?,?,?,?)', (pid, rid, gi, optional))

    def test_expiry_priority_applies_to_the_whole_corpus(self):
        match = search_inventory(self.engine, {'inventory': self.inventory, 'priority': 'match', 'limit': 1})
        expiry = search_inventory(self.engine, {'inventory': self.inventory, 'priority': 'expiry', 'limit': 1})
        self.assertNotEqual(match['results'][0]['id'], 1000)
        self.assertEqual(expiry['results'][0]['id'], 1000)
        self.assertEqual(expiry['results'][0]['useFirst'][0]['batchId'], 'milk-first')

    def test_optional_garnish_does_not_override_mandatory_ingredients(self):
        result = search_inventory(self.engine, {'inventory': [x for x in self.inventory if x['id'] != 'rice'], 'priority': 'expiry', 'limit': 50})
        optional = next(x for x in result['results'] if x['id'] == 1001)
        self.assertEqual(optional['earliestDeadline'], self.inventory[0]['deadline'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
