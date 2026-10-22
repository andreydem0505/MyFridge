"""Russian pantry search against the full local corpus. Python 3.9+."""
import argparse
import json
import sqlite3
import time
from pathlib import Path

from normalizer import Normalizer, clean, ru_key, en_key

ROOT = Path(__file__).resolve().parent


class RecipeSearch:
    def __init__(self, database=ROOT / 'recipes.sqlite'):
        self.database = Path(database).resolve()
        self.norm = Normalizer()

    def connect(self):
        if not self.database.is_file():
            raise FileNotFoundError(str(self.database))
        con = sqlite3.connect(self.database.as_uri() + '?mode=ro', uri=True)
        con.row_factory = sqlite3.Row
        con.execute('PRAGMA cache_size=-50000')
        return con

    def resolve_inputs(self, con, values):
        resolved, unknown, ids = [], [], set()
        for raw in values:
            raw = str(raw).strip()
            if not raw:
                continue
            key = ru_key(raw)
            value = self.norm.resolve(raw, 'ru')
            # Curated vocabulary wins over noisy aliases inferred from source text.
            rows = []
            if value and value[0].startswith('known:'):
                rows = con.execute('SELECT id,name,localized FROM products WHERE stable_key=?', (value[0],)).fetchall()
            if not rows:
                rows = con.execute('''SELECT p.id,p.name,p.localized FROM aliases a
                    JOIN products p ON p.id=a.product_id WHERE a.language='ru' AND a.alias=?''', (key,)).fetchall()
            if not rows:
                if value:
                    rows = con.execute('SELECT id,name,localized FROM products WHERE stable_key=?', (value[0],)).fetchall()
            if not rows:
                rows = con.execute('''SELECT p.id,p.name,p.localized FROM aliases a
                    JOIN products p ON p.id=a.product_id WHERE a.language='en' AND a.alias=?''', (en_key(raw),)).fetchall()
            if not rows:
                unknown.append(raw)
                continue
            # Ambiguous aliases must be confirmed; they do not silently satisfy multiple foods.
            if len(rows) != 1:
                unknown.append(raw)
                resolved.append({'input': raw, 'ambiguous': [dict(r) for r in rows]})
                continue
            item = dict(rows[0])
            ids.add(item['id'])
            resolved.append({'input': raw, **item})
        return ids, resolved, unknown

    def search(self, products, pantry=None, language='ru', limit=20, max_missing=None,
               use_all=False, require_instructions=True):
        if language not in ('ru', 'en', 'all'):
            raise ValueError('language must be ru, en or all')
        products, pantry = list(products), list(pantry or [])
        if len(products) + len(pantry) > 40:
            raise ValueError('At most 40 product names per request')
        if any(not isinstance(x, str) or len(x) > 200 for x in products + pantry):
            raise ValueError('Product names must be strings of at most 200 characters')
        limit = max(1, min(int(limit), 100))
        if max_missing is not None and int(max_missing) < 0:
            raise ValueError('max_missing must be nonnegative')
        started = time.monotonic()
        con = self.connect()
        try:
            query_ids, resolved, unknown = self.resolve_inputs(con, products)
            pantry_ids, resolved_pantry, unknown_pantry = self.resolve_inputs(con, pantry)
            available = query_ids | pantry_ids
            response = {'products': resolved, 'unrecognized': unknown,
                        'pantry': resolved_pantry, 'unrecognized_pantry': unknown_pantry,
                        'language': language, 'results': [],
                        'matching_scope': 'ingredient_names_only',
                        'notice': 'Совпадение по названиям не проверяет количества и состояние продуктов. Сверяйте исходный список.'}
            if not query_ids:
                response['elapsed_ms'] = round((time.monotonic() - started) * 1000)
                return response
            query_ids = sorted(query_ids)
            all_ids = sorted(available)
            placeholders = ','.join('?' for _ in all_ids)
            qplaceholders = ','.join('?' for _ in query_ids)
            conditions = ['r.required_count > 0']
            params = list(query_ids) + list(all_ids)
            range_clause = ''
            if language != 'all':
                first = con.execute('SELECT id FROM recipes WHERE language=? ORDER BY id LIMIT 1', (language,)).fetchone()
                last = con.execute('SELECT id FROM recipes WHERE language=? ORDER BY id DESC LIMIT 1', (language,)).fetchone()
                if not first:
                    response['elapsed_ms'] = round((time.monotonic() - started) * 1000)
                    return response
                # Restrict the covering index before grouping. The outer language
                # check remains necessary for imported corpora with interleaved IDs.
                range_clause = 'AND rp.recipe_id BETWEEN ? AND ?'
                params.extend([first[0], last[0]])
                conditions.append('r.language=?')
                params.append(language)
            if require_instructions:
                conditions.append('r.has_instructions=1')
            if max_missing is not None:
                conditions.append('(r.required_count-h.matched)<=?')
                params.append(int(max_missing))
            if use_all:
                conditions.append('h.query_products=?')
                params.append(len(query_ids))
            # No candidate sampling: rank every matching recipe in the database.
            sql = f'''
                WITH hits AS (
                  SELECT rp.recipe_id,
                    count(DISTINCT CASE WHEN rp.optional=0 THEN rp.group_index END) AS matched,
                    count(DISTINCT CASE WHEN rp.product_id IN ({qplaceholders}) THEN rp.product_id END) AS query_products
                  FROM recipe_product rp
                  WHERE rp.product_id IN ({placeholders}) {range_clause}
                  GROUP BY rp.recipe_id
                )
                SELECT r.*,h.matched,h.query_products,r.required_count-h.matched AS missing_count
                FROM hits h JOIN recipes r ON r.id=h.recipe_id
                WHERE h.query_products>0 AND {' AND '.join(conditions)}
                ORDER BY missing_count ASC, h.query_products DESC, (r.language='ru') DESC,
                         r.untranslated_count ASC, r.required_count ASC,r.id ASC
                LIMIT ?
            '''
            params.append(limit * 3)
            rows = con.execute(sql, params).fetchall()
            product_details = {}
            seen = set()
            for row in rows:
                if row['fingerprint'] in seen:
                    continue
                seen.add(row['fingerprint'])
                ingredients = json.loads(row['ingredients_json'])
                groups = json.loads(row['requirements_json'])
                pids = {pid for _, options, _ in groups for pid in options}
                absent = pids - set(product_details)
                if absent:
                    product_details.update({r['id']: dict(r) for r in con.execute(
                        'SELECT id,name,localized FROM products WHERE id IN (' + ','.join('?' for _ in absent) + ')', sorted(absent))})
                matched, missing, optional = [], [], []
                for index, options, is_optional in groups:
                    item = {'original': ingredients[index],
                            'alternatives': [product_details[pid] for pid in options],
                            'matched_product_ids': [pid for pid in options if pid in available]}
                    if is_optional:
                        optional.append(item)
                    elif item['matched_product_ids']:
                        matched.append(item)
                    else:
                        missing.append(item)
                response['results'].append({
                    'id': row['id'], 'title': row['title'], 'language': row['language'],
                    'dataset': row['dataset'], 'source_url': row['source_url'],
                    'description': row['description'], 'ingredients': ingredients,
                    'instructions': json.loads(row['instructions_json']),
                    'matched': matched, 'missing': missing, 'optional': optional,
                    'required_count': row['required_count'], 'missing_count': len(missing),
                    'all_required_names_matched': not missing,
                    'untranslated_required_count': row['untranslated_count'],
                    'matched_query_products': row['query_products']
                })
                if len(response['results']) >= limit:
                    break
            response['elapsed_ms'] = round((time.monotonic() - started) * 1000)
            return response
        finally:
            con.close()

    def suggest(self, query, limit=20):
        prefix = ru_key(query)
        con = self.connect()
        try:
            if prefix:
                rows = con.execute('''SELECT DISTINCT p.id,p.name,p.recipe_count FROM aliases a
                    JOIN products p ON p.id=a.product_id
                    WHERE a.language='ru' AND a.alias>=? AND a.alias<? AND p.recipe_count>0
                    ORDER BY p.recipe_count DESC,p.name LIMIT ?''',
                    (prefix, prefix + '\uffff', min(int(limit), 100))).fetchall()
            else:
                rows = con.execute('''SELECT id,name,recipe_count FROM products
                    WHERE localized=1 AND recipe_count>0 ORDER BY recipe_count DESC LIMIT ?''',
                    (min(int(limit), 100),)).fetchall()
            return [dict(r) for r in rows]
        finally:
            con.close()

    def recipe(self, recipe_id):
        con = self.connect()
        try:
            row = con.execute('SELECT * FROM recipes WHERE id=?', (int(recipe_id),)).fetchone()
            if not row:
                return None
            result = dict(row)
            for field in ('ingredients', 'instructions', 'requirements'):
                result[field] = json.loads(result.pop(field + '_json'))
            return result
        finally:
            con.close()


if __name__ == '__main__':
    p = argparse.ArgumentParser(description='Поиск рецептов по русским названиям продуктов')
    p.add_argument('products', help='Продукты через запятую: картошка, яйца, лук')
    p.add_argument('--pantry', default='', help='Отдельно подтверждённые запасы, через запятую')
    p.add_argument('--language', default='ru', choices=['ru', 'en', 'all'])
    p.add_argument('--limit', type=int, default=10)
    p.add_argument('--max-missing', type=int)
    p.add_argument('--use-all', action='store_true')
    p.add_argument('--database', default=str(ROOT / 'recipes.sqlite'))
    a = p.parse_args()
    import re
    split = lambda text: [x.strip() for x in re.split('[,;\n]', text) if x.strip()]
    print(json.dumps(RecipeSearch(a.database).search(split(a.products), split(a.pantry),
          language=a.language, limit=a.limit, max_missing=a.max_missing, use_all=a.use_all), ensure_ascii=False, indent=2))
