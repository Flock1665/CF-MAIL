import { AxiosHeaders } from 'axios';
import { useGlobalState } from '../store';
import { safeBearerHeader, safeHeaderValue } from '../utils/headers';
import { SingleFlight } from '../utils/single-flight';
import { ErrorCode } from './error-codes';

const { userJwt, userSettings, jwt } = useGlobalState();
const mailboxPaths = new Set(['/api/settings', '/api/send_mail']);
const refreshRequests = new SingleFlight();

export const isUserAccessTokenError = (response) => response.status === 401
    && response.data?.code === ErrorCode.AUTH_USER_ACCESS_TOKEN_EXPIRED;

const canRetryUserAccessTokenRequest = (response) => {
    if (!isUserAccessTokenError(response)) return false;
    const { config } = response;
    if (config.url === '/user_api/settings') return false;
    if (!safeHeaderValue(config.headers.get('x-user-access-token'))) return false;

    const token = safeHeaderValue(config.headers.get('x-user-token'));
    if (token !== safeHeaderValue(userJwt.value)) return false;
    if (safeHeaderValue(config.headers.get('Authorization')) !== safeBearerHeader(jwt.value)) return false;
    return Boolean(token) || mailboxPaths.has(config.url);
};

async function loadUserSettings(token, client, headers) {
    const response = await client.get('/user_api/settings', { headers });
    if (response.status >= 300) {
        throw new Error(`[${response.status}]: ${response.data?.message || response.data}`);
    }
    if (safeHeaderValue(userJwt.value) === token) {
        Object.assign(userSettings.value, response.data);
    }
}

async function prepareRetryHeaders(client, config) {
    const headers = new AxiosHeaders(config.headers);
    headers.delete('x-user-access-token');
    const token = safeHeaderValue(config.headers.get('x-user-token'));
    if (!token) return headers;

    const accessToken = safeHeaderValue(userSettings.value.access_token);
    if (accessToken === safeHeaderValue(config.headers.get('x-user-access-token'))) {
        try {
            await refreshRequests.run(token, () => loadUserSettings(token, client, config.headers));
        } catch (error) {
            if (!mailboxPaths.has(config.url)) throw error;
            return headers;
        }
    }

    const currentToken = safeHeaderValue(userSettings.value.access_token);
    if (currentToken) headers.set('x-user-access-token', currentToken);
    return headers;
}

export const interceptUserAccessTokenResponse = async (response, client) => {
    if (!canRetryUserAccessTokenRequest(response)) return response;
    const { config } = response;
    const token = safeHeaderValue(config.headers.get('x-user-token'));
    const headers = await prepareRetryHeaders(client, config);
    if (token !== safeHeaderValue(userJwt.value)
        || safeHeaderValue(config.headers.get('Authorization')) !== safeBearerHeader(jwt.value)) {
        throw new Error('User session changed, please retry');
    }
    return await client.request({ ...config, headers });
};
