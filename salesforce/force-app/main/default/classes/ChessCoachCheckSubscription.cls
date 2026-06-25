/**
 * Deterministic subscription gate for the MIAW chess coach. Returns whether the verified player's
 * Contact has an active paid subscription (Contact.Is_Subscribed__c).
 *
 * WHY: coaching is a paid feature. Everyone can play the computer and open the coach, but only
 * subscribed Contacts get real coaching — unsubscribed users get an upsell. The Chess_Coach agent
 * calls this in before_reasoning and branches on the boolean (deterministic Agent Script `if`), so
 * the LLM never decides eligibility. The headless coach (Chess_Coach_MCP) is gated separately in
 * Rails because its Agent API session is bypassUser (no Contact in context); both read this SAME
 * Contact field, so there is one source of truth.
 *
 * Identity key mirrors ChessCoachGetLiveGame: prefer the email passed straight from prechat
 * (@MessagingSession.Chess_Player_Email__c — reliable), fall back to resolving the Contact's email
 * from @MessagingEndUser.ContactId only if no email was supplied.
 *
 * Fails CLOSED: blank input, no matching Contact, or any ambiguity → isSubscribed = false. We never
 * grant coaching when we can't positively confirm a subscription.
 */
public with sharing class ChessCoachCheckSubscription {

    public class Request {
        @InvocableVariable(
            label='Player Email'
            description='The signed-in player\'s email (from the Chess_Player_Email prechat field). Preferred identity key — pass this when available.'
        )
        public String email;

        @InvocableVariable(
            label='Contact Id'
            description='Fallback: Id of the verified player\'s Contact (from @MessagingEndUser.ContactId), used only if Player Email is blank.'
        )
        public String contactId;
    }

    public class Result {
        @InvocableVariable(label='Is Subscribed' description='True only if a Contact was found AND it has an active subscription. Fails closed (false) on any doubt.')
        public Boolean isSubscribed;

        @InvocableVariable(label='Message' description='Short explanation the coach can relay when access is denied.')
        public String message;
    }

    @InvocableMethod(
        label='Check Subscription'
        description='Returns whether the verified player has an active paid coaching subscription (Contact.Is_Subscribed__c). Call this before coaching and only coach when it is true; otherwise tell the player a subscription is required.'
    )
    public static List<Result> checkSubscription(List<Request> requests) {
        List<Result> results = new List<Result>();
        for (Request req : requests) {
            results.add(checkOne(req));
        }
        return results;
    }

    private static Result checkOne(Request req) {
        Result r = new Result();
        r.isSubscribed = false; // fail closed by default
        r.message = 'Coaching requires an active subscription.';

        Contact c = resolveContact(req);
        if (c == null) {
            // No Contact resolved (anonymous / unknown email) → not subscribed.
            return r;
        }

        if (c.Is_Subscribed__c == true) {
            r.isSubscribed = true;
            r.message = 'Subscription active.';
        }
        return r;
    }

    // Resolve the player's Contact by email (preferred) or Contact Id (fallback), selecting the
    // subscription flag in the same query.
    private static Contact resolveContact(Request req) {
        if (String.isNotBlank(req.email)) {
            String email = req.email.trim();
            List<Contact> byEmail = [
                SELECT Id, Is_Subscribed__c FROM Contact WHERE Email = :email LIMIT 1
            ];
            if (!byEmail.isEmpty()) {
                return byEmail[0];
            }
        }
        if (String.isNotBlank(req.contactId)) {
            List<Contact> byId = [
                SELECT Id, Is_Subscribed__c FROM Contact WHERE Id = :req.contactId LIMIT 1
            ];
            if (!byId.isEmpty()) {
                return byId[0];
            }
        }
        return null;
    }
}
