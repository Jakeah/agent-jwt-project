/**
 * Shared HTTP client for the Chess Coach engine actions. Each agent action is its own invocable
 * class (Apex allows only one @InvocableMethod per class), but they all call the chess coaching
 * REST facade (Stockfish on Heroku) through here, via the ChessCoachApi Named Credential.
 *
 * This is the SUPPORTED path while the native Agentforce mcpTool:// binding is blocked in Beta.
 * Endpoints (POST JSON) — see chess-mcp/src/rest.js.
 */
public with sharing class ChessCoachClient {

    private static final String NAMED_CRED = 'callout:ChessCoachApi';

    public static Map<String, Object> postJson(String path, Map<String, Object> body) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(NAMED_CRED + path);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(120000); // engine search can take a few seconds
        req.setBody(JSON.serialize(body));
        HttpResponse res = new Http().send(req);
        Object parsed = JSON.deserializeUntyped(res.getBody());
        if (parsed instanceof Map<String, Object>) {
            return (Map<String, Object>) parsed;
        }
        return new Map<String, Object>{ 'error' => 'Unexpected response: ' + res.getBody() };
    }

    public static String str(Object o) {
        return o == null ? '' : String.valueOf(o);
    }
}
