// k6 load test: shoppers browsing the storefront, and buyers placing Cash on Delivery orders.
//
//   npm run loadtest:prep                      # once, before testing (writes loadtest/data.json)
//   k6 run -e PROFILE=smoke loadtest/checkout.js
//   k6 run loadtest/checkout.js                # full ramp, ~10 minutes
//   npm run loadtest:cleanup                   # always, afterwards
//
// It places REAL orders (named LOADTEST, phones 0130000xxxx) in the shared database; the cleanup
// script removes them and puts the stock back. The machine running it must be in the API's
// RATE_LIMIT_ALLOWLIST, or most requests come back 429.
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const STORE = __ENV.STORE_URL || 'https://owxmr2x8cjhjnctsvrkgh5rx.13.140.173.69.sslip.io';
const API = (__ENV.API_URL || 'https://kss2ucneseuomueurdbmysqa.13.140.173.69.sslip.io') + '/api/v1';
const data = JSON.parse(open('./data.json'));

const checkoutTime = new Trend('checkout_duration', true);
const orders = new Counter('orders_placed');
const outOfStock = new Counter('orders_out_of_stock');

const PROFILES = {
  // One of each, to check the script and the allowlist before the real run.
  smoke: {
    browse: { executor: 'shared-iterations', vus: 1, iterations: 2 },
    buy: { executor: 'shared-iterations', vus: 1, iterations: 2 },
  },
  // Ramps to 100 browsing and 20 buying shoppers at once.
  load: {
    browse: {
      executor: 'ramping-vus',
      stages: [
        { duration: '1m', target: 10 },
        { duration: '3m', target: 50 },
        { duration: '3m', target: 100 },
        { duration: '2m', target: 100 },
        { duration: '1m', target: 0 },
      ],
    },
    buy: {
      executor: 'ramping-vus',
      stages: [
        { duration: '1m', target: 3 },
        { duration: '3m', target: 10 },
        { duration: '3m', target: 20 },
        { duration: '2m', target: 20 },
        { duration: '1m', target: 0 },
      ],
    },
  },
};
const profile = PROFILES[__ENV.PROFILE || 'load'];

export const options = {
  scenarios: {
    browse: { ...profile.browse, exec: 'browse' },
    buy: { ...profile.buy, exec: 'buy' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{kind:page}': ['p(95)<2000'],
    'http_req_duration{kind:api}': ['p(95)<800'],
    checkout_duration: ['p(95)<3000'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'max'],
};

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const page = (name) => ({ tags: { kind: 'page', name } });
const api = (name, headers = {}) => ({
  headers: { 'Content-Type': 'application/json', ...headers },
  tags: { kind: 'api', name },
});

// A visitor: home, the shop, two products, with the API calls the pages make from the browser.
export function browse() {
  group('browse', () => {
    check(http.get(`${STORE}/`, page('home')), { 'home 200': (r) => r.status === 200 });
    sleep(1 + Math.random() * 2);
    check(http.get(`${STORE}/shop`, page('shop')), { 'shop 200': (r) => r.status === 200 });
    http.get(`${API}/products?limit=24`, api('products'));
    sleep(1 + Math.random() * 2);
    for (let i = 0; i < 2; i++) {
      const slug = pick(data.slugs);
      check(http.get(`${STORE}/product/${slug}`, page('product')), { 'product 200': (r) => r.status === 200 });
      http.get(`${API}/products/${slug}`, api('product'));
      sleep(2 + Math.random() * 3);
    }
  });
}

// A buyer: adds one or two items, gets a delivery quote, places a COD order.
export function buy() {
  let token;
  const lines = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < lines; i++) {
    const res = http.post(
      `${API}/cart/items`,
      JSON.stringify({ sku: pick(data.skus), qty: 1 }),
      api('cart_add', token ? { 'X-Cart-Token': token } : {}),
    );
    if (!check(res, { 'cart add 200': (r) => r.status === 200 })) return;
    token = token || res.json('token');
    sleep(1);
  }
  const areaId = pick(data.areaIds);
  check(http.get(`${API}/cart/quote?areaId=${areaId}`, api('quote', { 'X-Cart-Token': token })), {
    'quote 200': (r) => r.status === 200,
  });
  sleep(2 + Math.random() * 3); // filling in the form

  const id = `${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(
    `${API}/checkout`,
    JSON.stringify({
      name: `LOADTEST ${__VU}-${__ITER}`,
      phone: '0130000' + String(Math.floor(Math.random() * 10000)).padStart(4, '0'),
      areaId,
      address: 'House 1, Road 1, Load Test',
      paymentMethod: 'cod',
    }),
    {
      ...api('checkout', { 'X-Cart-Token': token, 'Idempotency-Key': `lt-${id}`.replace(/[^A-Za-z0-9_-]/g, '') }),
      // A sold-out item is a correct answer under load, not a failure.
      responseCallback: http.expectedStatuses(201, 409),
    },
  );
  checkoutTime.add(res.timings.duration);
  if (res.status === 201) orders.add(1);
  else if (res.status === 409) outOfStock.add(1);
  check(res, { 'order placed': (r) => r.status === 201 });
  sleep(3);
}
