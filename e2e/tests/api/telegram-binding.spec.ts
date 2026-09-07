import { expect, test, type APIRequestContext } from '@playwright/test';
import { createHmac } from 'node:crypto';

import { WORKER_URL, createTestAddress } from '../../fixtures/test-helpers';

function initData(userId: number) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId }),
  };
  const key = createHmac('sha256', 'WebAppData').update('e2e-telegram-test-token').digest();
  const hash = createHmac('sha256', key)
    .update(Object.entries(fields).map(([name, value]) => `${name}=${value}`).join('\n'))
    .digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

async function bind(request: APIRequestContext, userId: number, jwt: string) {
  const response = await request.post(`${WORKER_URL}/telegram/bind_address`, {
    data: { initData: initData(userId), jwt },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function unbind(request: APIRequestContext, userId: number, address: string, status = 200) {
  const response = await request.post(`${WORKER_URL}/telegram/unbind_address`, {
    data: { initData: initData(userId), address },
  });
  expect(response.status(), await response.text()).toBe(status);
}

async function addressList(request: APIRequestContext, userId: number) {
  const response = await request.post(`${WORKER_URL}/telegram/get_bind_address`, {
    data: { initData: initData(userId) },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('Telegram users can remove their own bindings after another user binds the mailbox', async ({ request }) => {
  const mailbox = await createTestAddress(request, 'tg-owner');
  const owner = Date.now();
  const other = owner + 1;
  try {
    await bind(request, owner, mailbox.jwt);
    await unbind(request, other, mailbox.address, 400);
    await unbind(request, owner, mailbox.address);

    await bind(request, owner, mailbox.jwt);
    await bind(request, other, mailbox.jwt);
    await unbind(request, owner, mailbox.address);
    expect(await addressList(request, owner)).toEqual([]);
    expect(await addressList(request, other)).toEqual([{ address: mailbox.address, jwt: mailbox.jwt }]);
    await unbind(request, other, mailbox.address);
    expect(await addressList(request, other)).toEqual([]);

    await bind(request, owner, mailbox.jwt);
    await bind(request, other, mailbox.jwt);
    await bind(request, owner, mailbox.jwt);
    expect(await addressList(request, owner)).toEqual([{ address: mailbox.address, jwt: mailbox.jwt }]);
    await unbind(request, other, mailbox.address);
    await unbind(request, owner, mailbox.address);
    expect(await addressList(request, owner)).toEqual([]);
  } finally {
    await request.delete(`${WORKER_URL}/api/delete_address`, {
      headers: { Authorization: `Bearer ${mailbox.jwt}` },
    });
  }
});

test('stale Telegram credentials cannot unbind; internal mailbox cleanup still works', async ({ request }) => {
  const original = await createTestAddress(request, 'tg-stale');
  const owner = Date.now();
  await bind(request, owner, original.jwt);
  const deletion = await request.delete(`${WORKER_URL}/admin/delete_address/${original.address_id}`);
  expect(deletion.ok()).toBe(true);
  const [name, domain] = original.address.split('@');
  const creation = await request.post(`${WORKER_URL}/admin/new_address`, {
    data: { name, domain, enablePrefix: false },
  });
  expect(creation.ok()).toBe(true);
  const recreated = await creation.json();
  try {
    expect(recreated.address_id).not.toBe(original.address_id);
    await unbind(request, owner, recreated.address, 400);
    const response = await request.delete(`${WORKER_URL}/api/delete_address`, {
      headers: { Authorization: `Bearer ${recreated.jwt}` },
    });
    expect(response.ok(), await response.text()).toBe(true);

    const listing = await request.post(`${WORKER_URL}/telegram/get_bind_address`, {
      data: { initData: initData(owner) },
    });
    expect(listing.ok()).toBe(true);
    expect(await listing.json()).toEqual([]);
  } finally {
    await request.delete(`${WORKER_URL}/admin/delete_address/${recreated.address_id}`);
  }
});
