const { randomUUID } = require('node:crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const table = process.env.TABLE_NAME;
const home = 'HOME#primary';
const json = (statusCode, value) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(value) });
const clean = value => String(value || '').replace(/\s/g, '');

async function rows(prefix) {
  const Items = [];
  let ExclusiveStartKey;
  do {
    const page = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': home, ':prefix': prefix }, ExclusiveStartKey }));
    Items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return Items;
}
const productRow = item => { const { pk, sk, kind, ...product } = item; return product; };
const eventRow = item => { const { pk, sk, kind, ...event } = item; return event; };
const pendingRow = item => { const { pk, sk, kind, ...pending } = item; return pending; };

exports.handler = async event => {
  try {
    const method = event.requestContext?.http?.method || 'GET';
    const path = event.rawPath || '';
    const input = event.body ? JSON.parse(event.body) : {};
    if (method === 'GET' && path === '/api/health') return json(200, { ok: true });
    if (method === 'GET' && path === '/api/state') {
      const [products, events, pendingScans] = await Promise.all([rows('PRODUCT#'), rows('EVENT#'), rows('PENDING#')]);
      return json(200, { products: products.map(productRow).sort((a,b) => b.createdAt.localeCompare(a.createdAt)), events: events.map(eventRow).sort((a,b) => b.at.localeCompare(a.at)), pendingScans: pendingScans.map(pendingRow).sort((a,b) => b.lastSeenAt.localeCompare(a.lastSeenAt)) });
    }
    if (method === 'POST' && path === '/api/products') {
      const barcode = clean(input.barcode);
      if (!input.name?.trim()) return json(400, { error: 'Product name is required.' });
      const now = new Date().toISOString();
      const id = barcode || randomUUID();
      const existing = barcode ? await db.send(new GetCommand({ TableName: table, Key: { pk: home, sk: `PRODUCT#${barcode}` } })) : {};
      const old = existing.Item;
      const product = { id: old?.id || id, barcode, name: input.name.trim(), brand: (input.brand || '').trim(), category: input.category || old?.category || 'Other', location: input.location || old?.location || 'Pantry', unit: input.unit || old?.unit || 'item', quantity: old?.quantity ?? Math.max(0, Number(input.quantity || 0)), createdAt: old?.createdAt || now, updatedAt: now };
      await db.send(new PutCommand({ TableName: table, Item: { pk: home, sk: `PRODUCT#${barcode || id}`, kind: 'product', ...product } }));
      if (!old && product.quantity > 0) await db.send(new PutCommand({ TableName: table, Item: { pk: home, sk: `EVENT#${now}#${randomUUID()}`, kind: 'event', id: randomUUID(), productId: product.id, barcode, productName: product.name, delta: product.quantity, source: 'setup', at: now } }));
      if (barcode) await db.send(new DeleteCommand({ TableName: table, Key: { pk: home, sk: `PENDING#${barcode}` } }));
      return json(201, { product });
    }
    if (method === 'POST' && path === '/api/scans') {
      const barcode = clean(input.barcode);
      if (!barcode) return json(400, { error: 'Barcode is required.' });
      const found = await db.send(new GetCommand({ TableName: table, Key: { pk: home, sk: `PRODUCT#${barcode}` } }));
      const product = found.Item;
      const now = new Date().toISOString();
      if (!product) {
        const key = { pk: home, sk: `PENDING#${barcode}` };
        const change = input.action === 'remove' ? -1 : 1;
        const result = await db.send(new UpdateCommand({ TableName: table, Key: key, UpdateExpression: 'SET id = if_not_exists(id, :id), barcode = if_not_exists(barcode, :barcode), firstSeenAt = if_not_exists(firstSeenAt, :now), lastSeenAt = :now, #kind = :kind ADD #count :one, delta :change', ExpressionAttributeNames: { '#kind': 'kind', '#count': 'count' }, ExpressionAttributeValues: { ':id': randomUUID(), ':barcode': barcode, ':now': now, ':kind': 'pending', ':one': 1, ':change': change }, ReturnValues: 'ALL_NEW' }));
        const pending = pendingRow(result.Attributes);
        return json(200, { status: 'needs_product', pending });
      }
      return applyStock(product, input.action === 'remove' ? -Math.max(1, Number(input.quantity || 1)) : Math.max(1, Number(input.quantity || 1)), input.source || 'scanner', now);
    }
    if (method === 'POST' && path === '/api/stock') {
      const products = await rows('PRODUCT#');
      const product = products.find(item => item.id === input.productId);
      if (!product) return json(404, { error: 'Product not found.' });
      return applyStock(product, Math.trunc(Number(input.delta)), 'app', new Date().toISOString());
    }
    return json(404, { error: 'Not found.' });
  } catch (error) {
    console.error('Inventory request failed', { name: error.name, message: error.message });
    return json(400, { error: 'Request failed. Please try again.' });
  }
};

async function applyStock(item, requestedDelta, source, now) {
  const quantity = Math.max(0, Number(item.quantity || 0) + requestedDelta);
  const delta = quantity - Number(item.quantity || 0);
  const product = { ...productRow(item), quantity, updatedAt: now };
  const event = { id: randomUUID(), productId: product.id, barcode: product.barcode, productName: product.name, delta, source, at: now };
  const operations = [{ Update: { TableName: table, Key: { pk: home, sk: item.sk }, UpdateExpression: 'SET quantity = :quantity, updatedAt = :updatedAt', ConditionExpression: 'quantity = :before', ExpressionAttributeValues: { ':quantity': quantity, ':updatedAt': now, ':before': Number(item.quantity || 0) } } }, { Put: { TableName: table, Item: { pk: home, sk: `EVENT#${now}#${event.id}`, kind: 'event', ...event } } }];
  try { await db.send(new TransactWriteCommand({ TransactItems: operations })); }
  catch (error) { if (error.name === 'TransactionCanceledException') return json(409, { error: 'Stock changed on another device. Refresh and try again.' }); throw error; }
  return json(200, { product, event, status: 'recorded' });
}
