import { describe, it, expect, vi } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { TrelloClient } from '../src/trello-client.js';
import { appendNextPageNote, formatCardListResponse } from '../src/card-list-preview.js';

// 24-hex card ids so they pass the cursor check. Higher number = newer card.
const id = (n: number) => n.toString(16).padStart(24, '0');

function card(n: number, closed: boolean, name = `Card ${n}`) {
  return {
    id: id(n),
    name,
    desc: '',
    due: null,
    idList: 'list1',
    idLabels: [],
    closed,
    url: '',
    dateLastActivity: '2026-11-01T00:00:00.000Z',
  };
}

function clientReturning(rows: unknown[]) {
  const client = new TrelloClient({ apiKey: 'fake', token: 'fake', boardId: 'board1' });
  const get = vi.fn(() => Promise.resolve({ data: rows }));
  (client as any).axiosInstance = { get };
  return { client, get };
}

describe('getListsFiltered', () => {
  const LISTS = [
    { id: 'a', name: 'Open list', closed: false, idBoard: 'board1', pos: 1 },
    { id: 'b', name: 'Archived list', closed: true, idBoard: 'board1', pos: 2 },
  ];

  it('open returns only open lists', async () => {
    const { client } = clientReturning(LISTS);
    const lists = await client.getListsFiltered('board1', 'open');
    expect(lists.map((l) => l.id)).toEqual(['a']);
  });

  it('closed returns only archived lists', async () => {
    const { client } = clientReturning(LISTS);
    const lists = await client.getListsFiltered('board1', 'closed');
    expect(lists.map((l) => l.id)).toEqual(['b']);
  });

  it('all returns both, and always asks Trello for all lists', async () => {
    const { client, get } = clientReturning(LISTS);
    const lists = await client.getListsFiltered('board1', 'all');
    expect(lists).toHaveLength(2);
    expect(get).toHaveBeenCalledWith('/boards/board1/lists', { params: { filter: 'all' } });
  });

  it('uses the default board when none is given', async () => {
    const { client, get } = clientReturning(LISTS);
    await client.getListsFiltered(undefined, 'all');
    expect(get).toHaveBeenCalledWith('/boards/board1/lists', { params: { filter: 'all' } });
  });
});

describe('getCardsByListFiltered', () => {
  it('reads /cards/all with a limit and the slim default fields, never an unlimited read', async () => {
    const { client, get } = clientReturning([card(1, false)]);
    await client.getCardsByListFiltered('L1', { filter: 'all' });
    const [path, config] = get.mock.calls[0] as unknown as [string, { params: Record<string, unknown> }];
    expect(path).toBe('/lists/L1/cards/all');
    expect(config.params.limit).toBe(100);
    expect(config.params.fields).toBe('id,idShort,name,idList,closed,dateLastActivity,idLabels');
    expect(config.params.before).toBeUndefined();
  });

  it('closed keeps only archived cards', async () => {
    const { client } = clientReturning([card(1, false), card(2, true), card(3, true)]);
    const page = await client.getCardsByListFiltered('L1', { filter: 'closed' });
    expect(page.cards.map((c) => c.id)).toEqual([id(2), id(3)]);
  });

  it('open keeps only open cards', async () => {
    const { client } = clientReturning([card(1, false), card(2, true)]);
    const page = await client.getCardsByListFiltered('L1', { filter: 'open', limit: 50 });
    expect(page.cards.map((c) => c.id)).toEqual([id(1)]);
  });

  it('clamps the page size to 1000 for lists', async () => {
    const { client, get } = clientReturning([]);
    await client.getCardsByListFiltered('L1', { filter: 'all', limit: 99999 });
    expect((get.mock.calls[0] as any)[1].params.limit).toBe(1000);
  });

  it('adds id and closed to a custom field list so paging and filtering keep working', async () => {
    const { client, get } = clientReturning([]);
    await client.getCardsByListFiltered('L1', { filter: 'all', fields: 'name,labels' });
    expect((get.mock.calls[0] as any)[1].params.fields).toBe('name,labels,id,closed');
  });

  it('leaves fields=all alone', async () => {
    const { client, get } = clientReturning([]);
    await client.getCardsByListFiltered('L1', { filter: 'all', fields: 'all' });
    expect((get.mock.calls[0] as any)[1].params.fields).toBe('all');
  });

  it('applies the name filter after the archive filter', async () => {
    const { client } = clientReturning([
      card(1, true, 'Technical onboarding'),
      card(2, true, 'Strategic audit'),
      card(3, false, 'Technical audit'),
    ]);
    const page = await client.getCardsByListFiltered('L1', { filter: 'closed', nameFilter: 'AUDIT' });
    expect(page.cards.map((c) => c.id)).toEqual([id(2)]);
  });
});

describe('paging cursor', () => {
  it('a full page returns the OLDEST id on the raw page as the next cursor, even if rows are not in id order', async () => {
    // Trello does not return rows in id order; the cursor must be the minimum id, not the last row.
    const rows = [card(50, true), card(10, true), card(90, false), card(30, true)];
    const { client } = clientReturning(rows);
    const page = await client.getBoardCards('board1', { filter: 'all', limit: 4 });
    expect(page.nextBefore).toBe(id(10));
  });

  it('the cursor comes from the raw page, so a filtered page can be short and still have a next page', async () => {
    const rows = [card(40, false), card(30, false), card(20, false), card(10, true)];
    const { client } = clientReturning(rows);
    const page = await client.getBoardCards('board1', { filter: 'closed', limit: 4 });
    expect(page.cards.map((c) => c.id)).toEqual([id(10)]);
    expect(page.nextBefore).toBe(id(10));
  });

  it('a short page is the last page', async () => {
    const { client } = clientReturning([card(2, true), card(1, true)]);
    const page = await client.getBoardCards('board1', { filter: 'all', limit: 200 });
    expect(page.nextBefore).toBeUndefined();
  });

  it('an empty page is the last page', async () => {
    const { client } = clientReturning([]);
    const page = await client.getBoardCards('board1', { filter: 'all' });
    expect(page.cards).toEqual([]);
    expect(page.nextBefore).toBeUndefined();
  });

  it('passes the cursor to Trello as before', async () => {
    const { client, get } = clientReturning([]);
    await client.getBoardCards('board1', { filter: 'all', before: id(77) });
    expect((get.mock.calls[0] as any)[1].params.before).toBe(id(77));
  });

  it('rejects a cursor that is not a card id', async () => {
    const { client, get } = clientReturning([]);
    await expect(client.getBoardCards('board1', { before: 'not-an-id' })).rejects.toBeInstanceOf(McpError);
    await expect(
      client.getCardsByListFiltered('L1', { filter: 'all', before: '2026-11-01' })
    ).rejects.toBeInstanceOf(McpError);
    expect(get).not.toHaveBeenCalled();
  });

  it('fails loudly instead of looping when a full page holds nothing older than the cursor', async () => {
    const rows = [card(5, true), card(6, true)];
    const { client } = clientReturning(rows);
    await expect(
      client.getBoardCards('board1', { filter: 'all', limit: 2, before: id(5) })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('walks a whole board across pages with no duplicates and no gaps', async () => {
    // 450 cards, newest first within each page but shuffled, served 200 at a time by cursor.
    const everything = Array.from({ length: 450 }, (_, i) => card(i + 1, i % 3 !== 0));
    const client = new TrelloClient({ apiKey: 'fake', token: 'fake', boardId: 'board1' });
    (client as any).axiosInstance = {
      get: vi.fn((_path: string, config: { params: { limit: number; before?: string } }) => {
        const { limit, before } = config.params;
        const older = everything
          .filter((c) => (before ? c.id < before : true))
          .sort((x, y) => (x.id < y.id ? 1 : -1))
          .slice(0, limit);
        return Promise.resolve({ data: [...older].reverse() }); // deliberately not id-descending
      }),
    };
    const seen = new Set<string>();
    let before: string | undefined;
    let pages = 0;
    do {
      const page = await client.getBoardCards('board1', { filter: 'all', limit: 200, before });
      for (const c of page.cards) {
        expect(seen.has(c.id)).toBe(false);
        seen.add(c.id);
      }
      before = page.nextBefore;
      pages++;
    } while (before && pages < 10);
    expect(seen.size).toBe(450);
    expect(pages).toBe(3);
  });
});

describe('getBoardCards', () => {
  it('reads /boards/{id}/cards/all, defaults to all cards, 100 per page', async () => {
    const { client, get } = clientReturning([card(1, true), card(2, false)]);
    const page = await client.getBoardCards(undefined);
    const [path, config] = get.mock.calls[0] as unknown as [string, { params: Record<string, unknown> }];
    expect(path).toBe('/boards/board1/cards/all');
    expect(config.params.limit).toBe(100);
    expect(page.cards).toHaveLength(2);
  });

  it('clamps the page size to 500 for boards', async () => {
    const { client, get } = clientReturning([]);
    await client.getBoardCards('board1', { limit: 5000 });
    expect((get.mock.calls[0] as any)[1].params.limit).toBe(500);
  });

  it('returns closed, idList and dateLastActivity on every card', async () => {
    const { client } = clientReturning([card(1, true)]);
    const page = await client.getBoardCards('board1');
    expect(page.cards[0]).toMatchObject({
      closed: true,
      idList: 'list1',
      dateLastActivity: '2026-11-01T00:00:00.000Z',
    });
  });
});

describe('appendNextPageNote', () => {
  it('says how to get the next page, or that this was the last one', () => {
    const more = appendNextPageNote(formatCardListResponse([]), id(9), ' and the same listId');
    expect(more.content[more.content.length - 1].text).toContain(`before="${id(9)}"`);
    expect(more.content[more.content.length - 1].text).toContain('End of results');
    const done = appendNextPageNote(formatCardListResponse([]), undefined, '');
    expect(done.content[done.content.length - 1].text).toContain('End of results');
    expect(done.content[done.content.length - 1].text).not.toContain('before=');
  });
});
