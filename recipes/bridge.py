"""One JSON request on stdin, one JSON response on stdout. Main corpus is read-only."""
import json
import sqlite3
import sys
from search import RecipeSearch


def search_inventory(engine, request):
    inventory = request.get('inventory', [])
    if not inventory:
        return {'results': [], 'unrecognized': [], 'reason': 'Нет продуктов, доступных для подбора'}
    con = engine.connect()
    try:
        stock, unrecognized = {}, []
        for item in inventory:
            ids, resolved, unknown = engine.resolve_inputs(con, [item['name']])
            if not ids:
                unrecognized.append(item['name'])
            for pid in ids:
                if pid not in stock or item['deadline'] < stock[pid]['deadline']:
                    stock[pid] = item
        if not stock:
            return {'results': [], 'unrecognized': sorted(set(unrecognized))}
        con.execute('CREATE TEMP TABLE stock(product_id INTEGER PRIMARY KEY,deadline TEXT NOT NULL)')
        con.executemany('INSERT INTO stock VALUES (?,?)', [(pid, item['deadline']) for pid, item in stock.items()])
        language = request.get('language', 'ru')
        params, restriction = [], ''
        if language != 'all':
            first = con.execute('SELECT id FROM recipes WHERE language=? ORDER BY id LIMIT 1', (language,)).fetchone()
            last = con.execute('SELECT id FROM recipes WHERE language=? ORDER BY id DESC LIMIT 1', (language,)).fetchone()
            if not first:
                return {'results': [], 'unrecognized': unrecognized}
            restriction = 'AND rp.recipe_id BETWEEN ? AND ?'
            params.extend([first[0], last[0]])
        where = 'r.required_count>0 AND r.has_instructions=1 AND r.required_count-h.matched<=?'
        params.append(request.get('maxMissing', 0))
        if language != 'all':
            where += ' AND r.language=?'
            params.append(language)
        if request.get('priority') == 'expiry':
            order = 'h.earliest ASC,missing_count ASC,h.hits DESC,(r.language=\'ru\') DESC,r.id'
        else:
            order = 'missing_count ASC,h.hits DESC,(r.language=\'ru\') DESC,r.required_count ASC,h.earliest ASC,r.id'
        limit = min(max(int(request.get('limit', 12)), 1), 50)
        params.append(limit * 4)
        rows = con.execute(f'''
          WITH hits AS (
            SELECT rp.recipe_id,
              count(DISTINCT CASE WHEN rp.optional=0 THEN rp.group_index END) matched,
              count(DISTINCT CASE WHEN rp.optional=0 THEN rp.product_id END) hits,
              min(CASE WHEN rp.optional=0 THEN s.deadline END) earliest
            FROM recipe_product rp JOIN stock s ON s.product_id=rp.product_id
            WHERE 1=1 {restriction} GROUP BY rp.recipe_id
          )
          SELECT r.*,h.earliest,h.hits,r.required_count-h.matched missing_count
          FROM hits h JOIN recipes r ON r.id=h.recipe_id
          WHERE h.hits>0 AND {where} ORDER BY {order} LIMIT ?
        ''', params).fetchall()
        results, seen = [], set()
        for row in rows:
            if row['fingerprint'] in seen:
                continue
            seen.add(row['fingerprint'])
            ingredients = json.loads(row['ingredients_json'])
            missing, used = [], {}
            for index, options, optional in json.loads(row['requirements_json']):
                if optional:
                    continue
                available = [stock[pid] for pid in options if pid in stock]
                if available:
                    chosen = min(available, key=lambda x: x['deadline'])
                    used[chosen['id']] = {'batchId': chosen['id'], 'name': chosen['name'], 'deadline': chosen['deadline']}
                else:
                    names = [dict(x) for x in con.execute('SELECT id,name FROM products WHERE id IN (' + ','.join('?' for _ in options) + ')', options)]
                    missing.append({'original': ingredients[index], 'alternatives': names, 'matched_product_ids': []})
            results.append({'id': row['id'], 'title': row['title'], 'language': row['language'],
                'source_url': row['source_url'], 'dataset': row['dataset'], 'ingredients': ingredients,
                'instructions': json.loads(row['instructions_json']), 'missing_count': len(missing), 'missing': missing,
                'earliestDeadline': row['earliest'], 'useFirst': sorted(used.values(), key=lambda x: x['deadline'])})
            if len(results) == limit:
                break
        return {'results': results, 'unrecognized': sorted(set(unrecognized)), 'priority': request.get('priority', 'match')}
    finally:
        con.close()


if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        engine = RecipeSearch(sys.argv[1])
        if request.get('op') == 'suggest':
            result = {'products': engine.suggest(request.get('query', ''), 12)}
        else:
            result = search_inventory(engine, request)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
