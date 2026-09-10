import { themes } from './tokens';

describe('themes', () => {
  it('defines matching token keys for light and dark', () => {
    expect(Object.keys(themes.light).sort()).toEqual(Object.keys(themes.dark).sort());
  });

  it('uses the web primary blue in light mode', () => {
    expect(themes.light.primary).toBe('#2563eb');
  });
});
