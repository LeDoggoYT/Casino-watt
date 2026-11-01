"""Shared item market. All mutations run inside the application's SQLite transaction."""
import math
import time
from flask import g

SCHEMA = """
CREATE TABLE IF NOT EXISTS market_listings (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 opening_id INTEGER NOT NULL UNIQUE REFERENCES loot_inventory(opening_id) ON DELETE CASCADE,
 seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 price REAL NOT NULL CHECK(price > 0), created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS market_quotes (
 item_key TEXT PRIMARY KEY, price REAL NOT NULL, supply INTEGER NOT NULL,
 bucket INTEGER NOT NULL, change REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS market_supply_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, item_key TEXT NOT NULL, delta INTEGER NOT NULL, at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS market_events_time ON market_supply_events(item_key,at);
CREATE TABLE IF NOT EXISTS market_trades (
 id INTEGER PRIMARY KEY AUTOINCREMENT, item_key TEXT NOT NULL,
 seller_id INTEGER NOT NULL, buyer_id INTEGER, price REAL NOT NULL, at REAL NOT NULL);
"""


def advance(db, items, now=None):
    now = time.time() if now is None else now
    bucket = int(now // 600)
    for item in items:
        key = item['key']
        supply = db.execute('SELECT COUNT(*) FROM loot_inventory WHERE item_key=?', (key,)).fetchone()[0]
        db.execute('INSERT OR IGNORE INTO market_quotes(item_key,price,supply,bucket) VALUES (?,?,?,?)',
                   (key, max(.5, round(item['valueChf']*2)/2), supply, bucket))
        quote = db.execute('SELECT * FROM market_quotes WHERE item_key=?', (key,)).fetchone()
        if quote['bucket'] >= bucket:
            continue
        # Reconstruct completed intervals, including intervals without requests.
        events = db.execute('SELECT delta,at FROM market_supply_events WHERE item_key=? AND at>=? ORDER BY at',
                            (key, (quote['bucket']+1)*600)).fetchall()
        completed_supply = supply - sum(e['delta'] for e in events)
        price, previous, change = quote['price'], quote['supply'], 0
        boundaries = {quote['bucket']+1: completed_supply}
        running = completed_supply
        for event in events:
            running += event['delta']
            end = int(event['at']//600)+1
            if end <= bucket:
                boundaries[end] = running
        for end, count in sorted(boundaries.items()):
            delta = count - previous
            adjustment = max(-.10, min(.10, -delta / max(previous, 10)))
            updated = max(.5, min(item['valueChf']*2, max(item['valueChf']*.25, price*(1+adjustment))))
            updated = round(updated*2)/2
            change = round((updated/price-1)*100, 2)
            price, previous = updated, count
        if max(boundaries) < bucket:
            change = 0
        db.execute('UPDATE market_quotes SET price=?,supply=?,bucket=?,change=? WHERE item_key=?',
                   (price, previous, bucket, change, key))


def install(app, api):
    db_get, transaction = api['get_db'], api['transaction']
    items, error = api['LOOT_ITEMS'], api['ApiError']

    def snapshot(db, user):
        return dict(items=items, prices=[dict(r) for r in db.execute('SELECT * FROM market_quotes')],
                    serverTime=time.time(), nextUpdate=(int(time.time()//600)+1)*600,
                    balance=db.execute('SELECT amount FROM balances WHERE user_id=?', (user,)).fetchone()[0],
                    inventory=[dict(r) for r in db.execute('''SELECT i.item_key,COUNT(*) quantity,
                        SUM(CASE WHEN l.id IS NULL THEN 1 ELSE 0 END) available
                        FROM loot_inventory i LEFT JOIN market_listings l ON l.opening_id=i.opening_id
                        WHERE i.user_id=? GROUP BY i.item_key''', (user,))],
                    listings=[dict(r) for r in db.execute('''SELECT l.id,l.price,i.item_key,u.username,
                        l.seller_id=? AS mine FROM market_listings l JOIN loot_inventory i ON i.opening_id=l.opening_id
                        JOIN users u ON u.id=l.seller_id WHERE u.is_suspended=0 OR l.seller_id=? ORDER BY l.id DESC''', (user,user))])

    @app.get('/api/market/current', endpoint='market_current')
    @api['auth_required']
    def current():
        with transaction() as db:
            advance(db, items)
            data = snapshot(db, g.auth['user_id'])
        return api['ok'](data)

    @app.post('/api/market/<action>', endpoint='market_mutate')
    @api['auth_required']
    def mutate(action):
        if action not in ('list', 'buy', 'cancel', 'quick-sell'):
            raise error(404, 'Unbekannte Handelsaktion.')
        payload, user = api['body'](), g.auth['user_id']
        with transaction() as db:
            advance(db, items)
            api['register_action'](user, payload.get('actionId'), 'market-'+action)
            if action in ('list', 'quick-sell'):
                key = payload.get('itemKey')
                if not isinstance(key, str) or key not in api['LOOT_ITEM_MAP']:
                    raise error(400, 'Unbekannter Gegenstand.')
                owned = db.execute('''SELECT i.opening_id FROM loot_inventory i LEFT JOIN market_listings l
                    ON l.opening_id=i.opening_id WHERE i.user_id=? AND i.item_key=? AND l.id IS NULL LIMIT 1''', (user,key)).fetchone()
                if not owned:
                    raise error(409, 'Kein frei verfügbarer Gegenstand. Nimm zuerst dein Angebot zurück.')
                if action == 'list':
                    price = payload.get('price')
                    if isinstance(price,bool) or not isinstance(price,(float,int)) or not math.isfinite(price) or not .5 <= price <= 10000000 or price*2 != round(price*2):
                        raise error(400, 'Preis: 0,5 bis 10 Millionen Chips in 0,5er-Schritten.')
                    db.execute('INSERT INTO market_listings(opening_id,seller_id,price,created_at) VALUES (?,?,?,?)', (owned[0],user,price,time.time()))
                else:
                    quote = db.execute('SELECT price,bucket FROM market_quotes WHERE item_key=?', (key,)).fetchone()
                    if payload.get('quoteBucket') != quote['bucket']:
                        raise error(409, 'Der Preis wurde aktualisiert. Prüfe den neuen Schnellverkaufspreis.')
                    price = quote['price']
                    db.execute('DELETE FROM loot_inventory WHERE opening_id=?', (owned[0],))
                    db.execute('INSERT INTO market_supply_events(item_key,delta,at) VALUES (?,-1,?)', (key,time.time()))
                    db.execute('UPDATE balances SET amount=amount+?,updated_at=? WHERE user_id=?', (price,api['utc_now'](),user))
                    db.execute('INSERT INTO market_trades(item_key,seller_id,price,at) VALUES (?,?,?,?)', (key,user,price,time.time()))
            else:
                listing_id = payload.get('listingId')
                if type(listing_id) is not int:
                    raise error(400, 'Ungültiges Angebot.')
                listing = db.execute('''SELECT l.*,i.item_key,u.is_suspended FROM market_listings l
                    JOIN loot_inventory i ON i.opening_id=l.opening_id JOIN users u ON u.id=l.seller_id WHERE l.id=?''', (listing_id,)).fetchone()
                if not listing:
                    raise error(409, 'Dieses Angebot ist nicht mehr verfügbar.')
                if action == 'cancel':
                    if listing['seller_id'] != user:
                        raise error(403, 'Das ist nicht dein Angebot.')
                else:
                    if listing['seller_id'] == user or listing['is_suspended']:
                        raise error(400, 'Dieses Angebot kannst du nicht kaufen.')
                    changed = db.execute('UPDATE balances SET amount=amount-?,updated_at=? WHERE user_id=? AND amount>=?',
                                         (listing['price'],api['utc_now'](),user,listing['price']))
                    if not changed.rowcount:
                        raise error(400, 'Nicht genügend Chips.')
                    db.execute('UPDATE balances SET amount=amount+?,updated_at=? WHERE user_id=?', (listing['price'],api['utc_now'](),listing['seller_id']))
                    db.execute('UPDATE loot_inventory SET user_id=? WHERE opening_id=?', (user,listing['opening_id']))
                    db.execute('INSERT INTO market_trades(item_key,seller_id,buyer_id,price,at) VALUES (?,?,?,?,?)',
                               (listing['item_key'],listing['seller_id'],user,listing['price'],time.time()))
                db.execute('DELETE FROM market_listings WHERE id=?', (listing_id,))
            data = snapshot(db,user)
        return api['ok'](data)
