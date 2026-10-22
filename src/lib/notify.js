import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export const Urgency = MessageTray.Urgency;

/** One message-tray source ("Tuple") shared by all of the extension's notifications. */
export class Notifier {
    constructor(gicon) {
        this._gicon = gicon;
        this._source = null;
    }

    _getSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Tuple', icon: this._gicon});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    /**
     * @param {object} opts
     * @param {string} opts.title
     * @param {string} [opts.body]
     * @param {number} [opts.urgency] a MessageTray.Urgency
     * @param {boolean} [opts.resident] stay in the tray after an action is used
     * @param {string} [opts.iconName] overrides the Tuple icon
     * @param {Array<[string, Function]>} [opts.actions] [label, callback] pairs
     * @returns {MessageTray.Notification}
     */
    notify({title, body = '', urgency = Urgency.NORMAL, resident = false, iconName = null, actions = []}) {
        const source = this._getSource();
        const notification = new MessageTray.Notification({
            source,
            title,
            body,
            urgency,
            resident,
            isTransient: urgency === Urgency.LOW,
        });
        if (iconName)
            notification.iconName = iconName;
        for (const [label, callback] of actions)
            notification.addAction(label, callback);
        source.addNotification(notification);
        return notification;
    }

    error(title, message) {
        return this.notify({title, body: message, iconName: 'dialog-warning-symbolic'});
    }

    destroy() {
        this._source?.destroy();
        this._source = null;
    }
}
