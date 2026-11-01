"""Isolated market integration tests: no production database is opened."""
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

temp = tempfile.TemporaryDirectory()
os.environ['DATABASE_PATH'] = os.path.join(temp.name, 'market.sqlite')
os.environ['BCRYPT_ROUNDS'] = '10'
os.environ['NODE_ENV'] = 'development'
from app import app, get_db, RATE_BUCKETS
import market


class MarketTests(unittest.TestCase):
    def setUp(self):
        RATE_BUCKETS.clear()
        self.client = app.test_client()
        with app.app_context():
            db = get_db()
            for table in ('market_trades','market_supply_events','market_quotes','users'):
                db.execute('DELETE FROM '+table)
        self.seller = self.call('register', username='MarketSeller', password='Password12345')['token']
        self.buyer = self.call('register', username='MarketBuyer', password='Password12345')['token']

    def response(self, action, token=None, **body):
        path = '/api/auth/register' if action == 'register' else '/api/market/'+action
        return self.client.open(path, method='GET' if action=='current' else 'POST', json=body,
                                headers={'Authorization': 'Bearer '+token} if token else {})

    def call(self, action, token=None, **body):
        response = self.response(action,token,**body)
        self.assertLess(response.status_code,300,response.get_json())
        return response.get_json()['data']

    def mint(self):
        response = self.client.post('/api/loot/open', json={'box':'audio','actionId':'mint-market-item-0001'}, headers={'Authorization':'Bearer '+self.seller})
        self.assertEqual(response.status_code,200,response.get_json())
        return response.get_json()['data']['item']['key']

    def test_transfer_reservation_duplicate_and_quick_sale(self):
        key = self.mint()
        listed = self.call('list',self.seller,itemKey=key,price=100,actionId='market-list-test-0001')
        listing = listed['listings'][0]['id']
        self.assertEqual(listed['inventory'][0]['available'],0)
        quote = next(p for p in listed['prices'] if p['item_key']==key)
        self.assertEqual(self.response('quick-sell',self.seller,itemKey=key,quoteBucket=quote['bucket'],actionId='reserved-sale-test-0001').status_code,409)
        self.assertEqual(self.response('cancel',self.buyer,listingId=listing,actionId='foreign-cancel-0001').status_code,403)
        self.assertEqual(self.response('buy',self.seller,listingId=listing,actionId='self-buy-test-0001').status_code,400)
        bought = self.call('buy',self.buyer,listingId=listing,actionId='market-buy-test-0001')
        self.assertEqual(bought['balance'],900)
        self.assertEqual(bought['inventory'][0]['quantity'],1)
        self.assertEqual(self.response('buy',self.buyer,listingId=listing,actionId='market-buy-test-0001').status_code,409)
        self.assertEqual(self.response('buy',self.buyer,listingId=listing,actionId='market-buy-test-0002').status_code,409)
        seller = self.call('current',self.seller)
        self.assertEqual(seller['inventory'],[])
        self.assertEqual(seller['balance'],1034)
        self.assertEqual(self.response('quick-sell',self.buyer,itemKey=key,quoteBucket=quote['bucket']-1,actionId='stale-quote-test-0001').status_code,409)
        sold = self.call('quick-sell',self.buyer,itemKey=key,quoteBucket=quote['bucket'],actionId='quick-sale-test-0001')
        self.assertEqual(sold['balance'],900+quote['price'])
        self.assertEqual(sold['inventory'],[])
        history = self.client.get('/api/loot/current',headers={'Authorization':'Bearer '+self.seller}).get_json()['data']['history']
        self.assertEqual(history[0]['item_key'],key)

    def test_invalid_prices_cancel_and_insufficient_balance(self):
        key = self.mint()
        for price in (-1,0,.1,True,'100',10000001):
            self.assertEqual(self.response('list',self.seller,itemKey=key,price=price,actionId='invalid-price-test-001').status_code,400)
        listed = self.call('list',self.seller,itemKey=key,price=2000,actionId='market-list-test-0001')
        listing = listed['listings'][0]['id']
        self.assertEqual(self.response('buy',self.buyer,listingId=listing,actionId='too-poor-buy-test-0001').status_code,400)
        data = self.call('cancel',self.seller,listingId=listing,actionId='market-cancel-test-001')
        self.assertEqual(data['inventory'][0]['available'],1)
        self.assertEqual(data['listings'],[])

    def test_simultaneous_buyers_only_one_receives_item(self):
        other = self.call('register', username='MarketBuyerTwo', password='Password12345')['token']
        key = self.mint()
        listed = self.call('list',self.seller,itemKey=key,price=100,actionId='market-list-race-0001')
        listing = listed['listings'][0]['id']
        def buy(token):
            with app.test_client() as client:
                return client.post('/api/market/buy',json={'listingId':listing,'actionId':'market-buy-race-0001'},headers={'Authorization':'Bearer '+token}).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(buy,[self.buyer,other]))
        self.assertEqual(sorted(statuses),[200,409])
        buyers = [self.call('current',token) for token in (self.buyer,other)]
        self.assertEqual(sum(p['balance'] for p in buyers),1900)
        self.assertEqual(sum(len(p['inventory']) for p in buyers),1)

    def test_prices_follow_completed_ten_minute_intervals(self):
        with app.app_context():
            db = get_db()
            item = {'key':'earpods','valueChf':100}
            market.advance(db,[item],0)
            user = db.execute("SELECT id FROM users WHERE username='MarketSeller'").fetchone()[0]
            opening = db.execute("INSERT INTO loot_openings(user_id,box_key,price,payout,reward_index,created_at,item_key) VALUES (?,'audio',66,0,0,'test','earpods')",(user,)).lastrowid
            db.execute("INSERT INTO loot_inventory VALUES (?,?,'earpods')",(opening,user))
            db.execute("INSERT INTO market_supply_events(item_key,delta,at) VALUES ('earpods',1,100)")
            market.advance(db,[item],599)
            self.assertEqual(db.execute('SELECT price FROM market_quotes').fetchone()[0],100)
            market.advance(db,[item],600)
            self.assertEqual(db.execute('SELECT price FROM market_quotes').fetchone()[0],90)
            db.execute('DELETE FROM loot_inventory WHERE opening_id=?',(opening,))
            db.execute("INSERT INTO market_supply_events(item_key,delta,at) VALUES ('earpods',-1,700)")
            market.advance(db,[item],1200)
            self.assertEqual(db.execute('SELECT price FROM market_quotes').fetchone()[0],99)
            market.advance(db,[item],60000)
            self.assertEqual(db.execute('SELECT price FROM market_quotes').fetchone()[0],99)

if __name__ == '__main__':
    unittest.main()
