import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { EventEmitter } from 'node:events';
import type AlexaRemote from '../build/alexa-remote.js';
import { FakeAmazon, createAlexa } from './helpers.mts';

/** HTTP/2 session that never connects: the tests emit the push commands directly */
const fakeSession = (): EventEmitter =>
    Object.assign(new EventEmitter(), {
        close: (): void => undefined,
        destroy: (): void => undefined,
    });

describe('push events', () => {
    const fake = new FakeAmazon();
    const originalConnect = http2.connect;
    let alexa: AlexaRemote;

    /** Emits a push command like the HTTP/2 push connection does */
    const push = (command: string, payload: Record<string, any>): void => {
        alexa.alexahttp2Push!.emit('command', command, payload);
    };

    /** Records all events with the given name */
    const record = (event: string): any[] => {
        const events: any[] = [];
        alexa.on(event, data => events.push(data));
        return events;
    };

    before(async () => {
        fake.install();
        (http2 as any).connect = fakeSession;
        alexa = await createAlexa();
        alexa.authApiBearerToken = 'TOKEN';
        alexa.authApiBearerExpiry = Date.now() + 3600000;
        alexa.initPushConnection();
    });

    after(() => {
        alexa.stop();
        (http2 as any).connect = originalConnect;
        fake.uninstall();
    });

    it('emits do not disturb changes', () => {
        const events = record('ws-dnd-state-change');
        push('PUSH_DND_STATE_CHANGE', {
            destinationUserId: 'U1',
            dopplerId: { deviceSerialNumber: 'S1', deviceType: 'T1' },
            enabled: true,
        });
        assert.deepEqual(events, [
            { destinationUserId: 'U1', deviceSerialNumber: 'S1', deviceType: 'T1', enabled: true },
        ]);
    });

    it('emits now playing updates', () => {
        const events = record('ws-now-playing-updated');
        const nowPlayingData = { playerState: 'PLAYING', mediaId: 'M1', infoText: { title: 'Song' } };
        push('NotifyNowPlayingUpdated', {
            customerId: 'C1',
            update: { taskSessionId: 'TS1', update: { cause: 'PLAYBACK_STARTED', nowPlayingData } },
        });
        assert.deepEqual(events, [
            {
                customerId: 'C1',
                taskSessionId: 'TS1',
                cause: 'PLAYBACK_STARTED',
                mediaId: 'M1',
                playerState: 'PLAYING',
                nowPlayingData,
            },
        ]);
    });

    it('detects activities from volume and equalizer changes shortly after each other', () => {
        const simulated: string[] = [];
        alexa.simulateActivity = (serial: string): number => simulated.push(serial);
        const dopplerId = { deviceSerialNumber: 'S2', deviceType: 'T2' };

        // first values of a device always count as activity
        push('PUSH_VOLUME_CHANGE', { dopplerId, volumeSetting: 30, isMuted: false });
        push('PUSH_EQUALIZER_STATE_CHANGE', { dopplerId, bass: 1, treble: 1, midrange: 1 });
        assert.equal(simulated.length, 2);

        // a changed volume right after an equalizer change counts as activity
        push('PUSH_VOLUME_CHANGE', { dopplerId, volumeSetting: 40, isMuted: false });
        assert.equal(simulated.length, 3);

        // but not if the equalizer change is older
        alexa.lastEqualizer.S2.updated -= 5000;
        push('PUSH_VOLUME_CHANGE', { dopplerId, volumeSetting: 50, isMuted: false });
        assert.equal(simulated.length, 3);
    });

    it('reports unparsable push messages as unknown messages', () => {
        const events = record('ws-unknown-message');
        alexa.alexahttp2Push!.emit('unexpected-response', 'Could not parse json: {');
        assert.deepEqual(events, ['Could not parse json: {']);
    });
});
