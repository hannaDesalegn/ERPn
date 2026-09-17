import { NAV_SECTIONS, showsSampleData } from './navigation';

describe('which screens are labelled as sample data', () => {
  it('treats the sales order screens as real, including create, edit and detail', () => {
    for (const path of ['/sales/orders', '/sales/orders/new', '/sales/orders/abc/edit', '/sales/orders/abc']) {
      expect(showsSampleData(path)).toBe(false);
    }
  });

  it('does not extend a real prefix to a path that merely starts with the same letters', () => {
    expect(showsSampleData('/sales/orders-archive')).toBe(true);
  });

  it('labels every other navigation destination, the dashboard included', () => {
    const labelled = NAV_SECTIONS.flatMap((section) => section.items)
      .filter((item) => !showsSampleData(item.to))
      .map((item) => item.label);

    expect(labelled).toEqual(['Sales orders']);
    expect(showsSampleData('/')).toBe(true);
  });
});
