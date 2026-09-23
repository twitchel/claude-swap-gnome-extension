import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClaudeSwapIndicator} from './indicator.js';
import {CswapClient} from './cswap.js';

export default class ClaudeSwapExtension extends Extension {
    enable() {
        const settings = this.getSettings();

        this._indicator = new ClaudeSwapIndicator(this);
        Main.panel.addToStatusArea('claude-swap', this._indicator);

        this._client = new CswapClient({
            pathOverride: settings.get_string('cswap-path'),
        });
        this._indicator.start(this._client);

        this._pathChangedId = settings.connect('changed::cswap-path', () => {
            this._indicator.stop();
            this._client = new CswapClient({
                pathOverride: settings.get_string('cswap-path'),
            });
            this._indicator.start(this._client);
        });
        this._settings = settings;
    }

    disable() {
        if (this._pathChangedId) {
            this._settings.disconnect(this._pathChangedId);
            this._pathChangedId = null;
        }
        this._settings = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._client?.destroy();
        this._client = null;
    }
}
