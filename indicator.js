import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {panelText, iconState} from './format.js';

const SWITCH_FLASH_MS = 3000;

export const ClaudeSwapIndicator = GObject.registerClass(
class ClaudeSwapIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Claude Swap');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._flashId = 0;
        this._stale = false;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${extension.path}/icons/claude-robot-symbolic.svg`),
            style_class: 'system-status-icon',
        });

        this._label = new St.Label({
            style_class: 'cswap-label',
            y_align: Clutter.ActorAlign.CENTER,
            text: '',
        });

        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._settingsIds = [
            this._settings.connect('changed::panel-text', () => this._reRender()),
            this._settings.connect('changed::show-account-name', () => this._reRender()),
            this._settings.connect('changed::colour-code-icon', () => this._reRender()),
        ];

        this._snapshot = null;
    }

    /** Store a snapshot and redraw. Pass null to show the unknown state. */
    render(snapshot) {
        this._snapshot = snapshot;
        this._reRender();
    }

    _activeAccount() {
        const snap = this._snapshot;
        if (!snap?.accounts?.length)
            return null;
        return snap.accounts.find(a => a.active) ?? null;
    }

    _reRender() {
        const now = Date.now();
        const account = this._activeAccount();

        const prefs = {
            panelText: this._settings.get_string('panel-text'),
            showAccountName: this._settings.get_boolean('show-account-name'),
        };

        const text = panelText(account, prefs, now);
        this._label.text = text;
        this._label.visible = text !== '';

        for (const cls of ['cswap-ok', 'cswap-warn', 'cswap-crit', 'cswap-stale'])
            this._icon.remove_style_class_name(cls);

        if (this._settings.get_boolean('colour-code-icon'))
            this._icon.add_style_class_name(`cswap-${iconState(account, now)}`);

        if (this._stale)
            this._icon.add_style_class_name('cswap-stale');
    }

    setStale(isStale) {
        this._stale = isStale;
        this._reRender();
    }

    /** Tint the icon with the accent colour briefly after an auto-switch. */
    flashSwitched() {
        if (this._flashId) {
            GLib.Source.remove(this._flashId);
            this._flashId = 0;
        }
        this._icon.add_style_class_name('cswap-switched');
        this._flashId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SWITCH_FLASH_MS, () => {
                this._icon.remove_style_class_name('cswap-switched');
                this._flashId = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    destroy() {
        if (this._flashId) {
            GLib.Source.remove(this._flashId);
            this._flashId = 0;
        }
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        super.destroy();
    }
});
