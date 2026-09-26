import { gml, gmlFunction, pureGmlFunction, runGmlLines } from './gml';

// The settings of the GameMaker client (US-026, US-027). There is no GML
// runtime in this repository, so this is a check of the SOURCE of the game:
// small pure pieces (the volume step, the screen scale) are really executed,
// the rest is checked to be wired the way the spec says. That the game does
// what the source says stays a manual check (ASM-024, ASM-049).
const create = () => gml('objects/obj_menu/Create_0.gml');
const step = () => gml('objects/obj_menu/Step_0.gml');
const draw = () => gml('objects/obj_menu/Draw_64.gml');

describe('Client settings — static checks of the GameMaker source', () => {
  describe('volume (AC-063)', () => {
    const volumeStep = () => pureGmlFunction(create(), 'volume_step');

    it('AC-063: every press moves the volume by exactly 10% @spec:AC-063', () => {
      const v = volumeStep();

      expect(v(0.5, 1)).toBe(0.6);
      expect(v(0.5, -1)).toBe(0.4);
      expect(v(0.3, 1)).toBe(0.4);
      expect(v(0.7, -1)).toBe(0.6);
    });

    it('AC-063: from 100% ten presses down reach exactly 0% and never go below @spec:AC-063', () => {
      const v = volumeStep();
      let volume = 1;
      const seen: number[] = [];

      for (let press = 0; press < 12; press++) {
        volume = v(volume, -1);
        seen.push(volume);
      }

      expect(seen).toEqual([
        0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0, 0, 0,
      ]);
    });

    it('AC-063: from 0% ten presses up reach exactly 100% and never go above @spec:AC-063', () => {
      const v = volumeStep();
      let volume = 0;
      const seen: number[] = [];

      for (let press = 0; press < 12; press++) {
        volume = v(volume, 1);
        seen.push(volume);
      }

      expect(seen).toEqual([
        0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1, 1,
      ]);
    });

    it('AC-063: a volume that drifted in the saved file is brought back to a clean 10% step @spec:AC-063', () => {
      const v = volumeStep();

      expect(v(0.30000000000000004, 0)).toBe(0.3);
      expect(v(0.9999999999999999, 0)).toBe(1);
      expect(v(7, 0)).toBe(1); // out of range values are clamped
      expect(v(-3, 0)).toBe(0);
    });

    it('AC-063: left/right on MÚSICA or SONS uses that step, is heard at once and is saved @spec:AC-063', () => {
      const source = step();
      const left =
        /_left and global\.s_values\[index\] > 0\s*\{([\s\S]*?)\n\t\}/.exec(
          source,
        );
      const right =
        /_right and global\.s_values\[index\] < 1\s*\{([\s\S]*?)\n\t\}/.exec(
          source,
        );

      expect(left).not.toBeNull();
      expect(right).not.toBeNull();
      expect(left![1]).toMatch(
        /global\.s_values\[index\]\s*=\s*volume_step\(global\.s_values\[index\],\s*-1\)/,
      );
      expect(right![1]).toMatch(
        /global\.s_values\[index\]\s*=\s*volume_step\(global\.s_values\[index\],\s*1\)/,
      );
      for (const branch of [left![1], right![1]]) {
        expect(branch).toMatch(
          /audio_sound_gain\(snd_soundtrack,\s*global\.s_values\[0\],\s*0\)/,
        );
        expect(branch).toMatch(
          /audio_sound_gain\(snd_tap1,\s*global\.s_values\[1\],\s*0\)/,
        );
        expect(branch).toMatch(/settings_save\(\)/);
      }
    });

    it('AC-063: the volumes are saved to and read from the same keys of factory_rebellion.ini @spec:AC-063', () => {
      const save = gmlFunction(create(), 'settings_save');
      const load = gmlFunction(create(), 'settings_load');

      for (const fn of [save, load]) {
        expect(fn).toContain('ini_open("factory_rebellion.ini")');
      }
      expect(save).toMatch(
        /ini_write_real\("audio",\s*"music",\s*global\.s_values\[0\]\)/,
      );
      expect(save).toMatch(
        /ini_write_real\("audio",\s*"sfx",\s*global\.s_values\[1\]\)/,
      );
      expect(load).toMatch(/ini_read_real\("audio",\s*"music"/);
      expect(load).toMatch(/ini_read_real\("audio",\s*"sfx"/);
    });

    it('AC-063: after restarting, the saved volumes are applied to the sounds right away @spec:AC-063', () => {
      const source = create();

      expect(source).toMatch(/settings_load\(\)/);
      expect(source).toMatch(
        /audio_sound_gain\(snd_soundtrack,\s*global\.s_values\[0\],\s*0\)/,
      );
      expect(source).toMatch(
        /audio_sound_gain\(snd_tap1,\s*global\.s_values\[1\],\s*0\)/,
      );
    });

    it('AC-063: the screen shows the volume as a whole percentage @spec:AC-063', () => {
      expect(draw()).toMatch(/global\.s_values\[_v_index\]\s*\*\s*100/);
    });
  });

  describe('fullscreen (AC-064)', () => {
    it('AC-064: F11 switches between fullscreen and window @spec:AC-064', () => {
      expect(step()).toMatch(
        /if \(keyboard_check_pressed\(vk_f11\)\) display_toggle_fullscreen\(\);/,
      );
    });

    it('AC-064: TELA CHEIA in OPÇÕES switches too, with left, right or enter @spec:AC-064', () => {
      const source = step();

      expect(source).toMatch(
        /if index == 2\s*\{\s*if _left or _right or keyboard_check_pressed\(vk_enter\)\s*\{\s*display_toggle_fullscreen\(\);/,
      );
    });

    it('AC-064: switching applies the new mode and saves it @spec:AC-064', () => {
      const toggle = gmlFunction(create(), 'display_toggle_fullscreen');

      expect(toggle).toMatch(/display_apply\(!global\.fullscreen\);/);
      expect(toggle).toMatch(/settings_save\(\);/);
    });

    it('AC-064: the mode is saved to and read from the same key, and applied at start @spec:AC-064', () => {
      const save = gmlFunction(create(), 'settings_save');
      const load = gmlFunction(create(), 'settings_load');

      expect(save).toMatch(
        /ini_write_real\("display",\s*"fullscreen",\s*global\.fullscreen \? 1 : 0\)/,
      );
      expect(load).toMatch(
        /global\.fullscreen = ini_read_real\("display",\s*"fullscreen",\s*1\) >= 1;/,
      );
      expect(step()).toMatch(/display_apply\(global\.fullscreen\)/);
    });

    it('AC-064: both modes end by fitting the 1366x768 layout to the window @spec:AC-064', () => {
      const apply = gmlFunction(create(), 'display_apply');

      expect(apply.match(/display_recalc_gui\(/g)).toHaveLength(2); // fullscreen and window
      expect(apply).toMatch(/window_set_showborder\(false\)/); // fullscreen: borderless
      expect(apply).toMatch(/window_set_showborder\(true\)/);
      expect(apply).toMatch(/window_center\(\)/);
    });

    it.each([
      [1366, 768, 1, 0, 0],
      [2732, 1536, 2, 0, 0],
      [1920, 1080, 1920 / 1366, 0, (1080 - 768 * (1920 / 1366)) / 2],
      [1280, 1024, 1280 / 1366, 0, (1024 - 768 * (1280 / 1366)) / 2],
      [1000, 400, 400 / 768, (1000 - 1366 * (400 / 768)) / 2, 0],
    ])(
      'AC-064: in a %ix%i window the layout is scaled to fit and centered @spec:AC-064',
      (w, h, scale, ox, oy) => {
        const recalc = gmlFunction(create(), 'display_recalc_gui');
        // only the two lines that decide scale and centering (they are pure)
        const lines = [
          /var _scale = min\([^;]*;/.exec(recalc)![0],
          /global\.gui_ox = [^;]*;/.exec(recalc)![0],
          /global\.gui_oy = [^;]*;/.exec(recalc)![0],
        ];

        const result = runGmlLines(lines, { _w: w, _h: h });

        expect(result.gui_ox).toBeCloseTo(ox, 6);
        expect(result.gui_oy).toBeCloseTo(oy, 6);
        // the whole 1366x768 area fits inside the window
        expect(1366 * scale + 2 * result.gui_ox).toBeLessThanOrEqual(w + 1e-6);
        expect(768 * scale + 2 * result.gui_oy).toBeLessThanOrEqual(h + 1e-6);
      },
    );
  });

  describe('Discord link (AC-065)', () => {
    it('AC-065: clicking the button in the top-left corner opens the community invite @spec:AC-065', () => {
      const source = draw();

      // the button sits 20 px from the top-left corner
      expect(source).toMatch(/var _cx1 = 20 \+ _sprw;/);
      expect(source).toMatch(/var _cy1 = 20 \+ _sprh;/);
      // hovering it and pressing the left mouse button opens the invite
      expect(source).toMatch(
        /if point_in_rectangle\(_mx, _my, _cx1 - _sprw, _cy1 - _sprh, _cx1 \+ _sprw, _cy1 \+ _sprh\)[\s\S]*?if mouse_check_button_pressed\(mb_left\)\s*\{\s*url_open\("https:\/\/discord\.gg\/[A-Za-z0-9]+"\);/,
      );
    });

    it('AC-065: the button is drawn in every menu screen (it is outside the per-screen branches) @spec:AC-065', () => {
      const source = draw();
      const button = source.indexOf('draw_sprite_ext(spr_button_dc');
      const firstScreen = source.indexOf('if state == 0');

      expect(button).toBeGreaterThan(-1);
      expect(button).toBeLessThan(firstScreen);
    });
  });

  it('T-030: no leftover DIAG debug messages in the menu', () => {
    for (const source of [create(), step(), draw()]) {
      expect(source).not.toMatch(/DIAG/);
      expect(source).not.toMatch(/show_debug_message\(_c_index\)/);
    }
  });
});
