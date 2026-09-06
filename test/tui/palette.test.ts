import { describe, expect, test } from 'bun:test';
import {
  buildPanelPalette,
  themeColorToHex,
  toneBrandHex,
} from '../../src/tui/tui-panel/palette.ts';

describe('themeColorToHex', () => {
  test('парсит hex-строку с #', () => {
    expect(themeColorToHex('#ff8800', '#000')).toBe('#ff8800');
  });

  test('возвращает fallback для null', () => {
    expect(themeColorToHex(null, '#ccc')).toBe('#ccc');
  });

  test('возвращает fallback для undefined', () => {
    expect(themeColorToHex(undefined, '#ccc')).toBe('#ccc');
  });

  test('возвращает fallback для не-# строки', () => {
    expect(themeColorToHex('abc', '#000')).toBe('#000');
  });

  test('возвращает fallback для числа', () => {
    expect(themeColorToHex(12345, '#999')).toBe('#999');
  });

  test('парсит объект { r, g, b } 0-255', () => {
    expect(themeColorToHex({ r: 255, g: 128, b: 0 }, '#000')).toBe('#ff8000');
  });

  test('парсит объект { r, g, b } 0-1 и масштабирует', () => {
    expect(themeColorToHex({ r: 1, g: 0.5, b: 0 }, '#000')).toBe('#ff8000');
  });

  test('возвращает fallback для объекта без r/g/b', () => {
    expect(themeColorToHex({ x: 1 }, '#abc')).toBe('#abc');
  });



  test('возвращает fallback для пустой строки', () => {
    expect(themeColorToHex('', '#xyz')).toBe('#xyz');
  });
});

describe('toneBrandHex', () => {
  test('возвращает #rrggbb для валидного hex', () => {
    const result = toneBrandHex('#3366ff', '#888');
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
    expect(result).not.toBe('#888');
  });

  test('возвращает fallback для невалидного входа', () => {
    expect(toneBrandHex('zzz', '#ccc')).toBe('#ccc');
  });

  test('не выбрасывает на уже ненасыщенном цвете', () => {
    const result = toneBrandHex('#888888', '#000');
    expect(result).toBe('#888888');
  });
});

describe('buildPanelPalette', () => {
  const fullTheme = {
    primary: '#4a90d9',
    text: '#e0e0e0',
    textMuted: '#999999',
    success: '#27ae60',
    warning: '#f39c12',
    error: '#e74c3c',
    border: '#555555',
  };

  test('возвращает все 7 ключей', () => {
    const pal = buildPanelPalette(fullTheme);
    expect(pal).toHaveProperty('primary');
    expect(pal).toHaveProperty('text');
    expect(pal).toHaveProperty('muted');
    expect(pal).toHaveProperty('success');
    expect(pal).toHaveProperty('warning');
    expect(pal).toHaveProperty('error');
    expect(pal).toHaveProperty('border');
  });

  test('все значения — #rrggbb строки', () => {
    const pal = buildPanelPalette(fullTheme);
    for (const val of Object.values(pal)) {
      expect(val).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test('использует FALLBACK для отсутствующих ключей', () => {
    const pal = buildPanelPalette({});
    expect(pal.primary).toBe('#8B9DAF');
    expect(pal.text).toBe('#C5C5BB');
    expect(pal.muted).toBe('#7A7A72');
    expect(pal.success).toBe('#9CAF8B');
    expect(pal.warning).toBe('#C5B88D');
    expect(pal.error).toBe('#B08A8A');
    expect(pal.border).toBe('#6B6B63');
  });

  test('десатурирует яркие цвета', () => {
    const bright = {
      primary: '#ff0000',
      text: '#00ff00',
      textMuted: '#0000ff',
      success: '#ffff00',
      warning: '#ff00ff',
      error: '#00ffff',
      border: '#ffffff',
    };
    const pal = buildPanelPalette(bright);
    // Все должны быть "приглушены" — не совпадать с исходными
    expect(pal.primary).not.toBe('#ff0000');
    expect(pal.text).not.toBe('#00ff00');
    expect(pal.muted).not.toBe('#0000ff');
  });
});
