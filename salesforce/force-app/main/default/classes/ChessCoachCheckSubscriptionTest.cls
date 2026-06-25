/**
 * Tests for ChessCoachCheckSubscription — the deterministic coaching gate. Covers: subscribed
 * Contact → true; unsubscribed → false; resolution by email (preferred) and by Contact Id
 * (fallback); and the fail-closed paths (blank input, unknown email, no Contact) → false.
 */
@isTest
private class ChessCoachCheckSubscriptionTest {

    private static Contact seedContact(String email, Boolean subscribed) {
        Contact c = new Contact(LastName = 'Player', FirstName = 'Jordan', Email = email, Is_Subscribed__c = subscribed);
        insert c;
        return c;
    }

    private static ChessCoachCheckSubscription.Result run(String email, String contactId) {
        ChessCoachCheckSubscription.Request req = new ChessCoachCheckSubscription.Request();
        req.email = email;
        req.contactId = contactId;
        return ChessCoachCheckSubscription.checkSubscription(
            new List<ChessCoachCheckSubscription.Request>{ req }
        )[0];
    }

    @isTest
    static void subscribedByEmail() {
        seedContact('subbed@example.com', true);
        Test.startTest();
        ChessCoachCheckSubscription.Result r = run('subbed@example.com', null);
        Test.stopTest();
        System.assertEquals(true, r.isSubscribed, 'subscribed Contact should pass');
    }

    @isTest
    static void unsubscribedByEmail() {
        seedContact('free@example.com', false);
        Test.startTest();
        ChessCoachCheckSubscription.Result r = run('free@example.com', null);
        Test.stopTest();
        System.assertEquals(false, r.isSubscribed, 'unsubscribed Contact should be gated');
    }

    @isTest
    static void subscribedByContactIdFallback() {
        // No email on the request → resolve via Contact Id.
        Contact c = seedContact('byid@example.com', true);
        Test.startTest();
        ChessCoachCheckSubscription.Result r = run(null, c.Id);
        Test.stopTest();
        System.assertEquals(true, r.isSubscribed, 'Contact-Id fallback should resolve the subscription');
    }

    @isTest
    static void emailPreferredOverContactId() {
        // Email matches a SUBSCRIBED contact; the supplied contactId points at an UNSUBSCRIBED one.
        // Email is the preferred key, so the result should follow the email's Contact (subscribed).
        seedContact('preferred@example.com', true);
        Contact other = seedContact('other@example.com', false);
        Test.startTest();
        ChessCoachCheckSubscription.Result r = run('preferred@example.com', other.Id);
        Test.stopTest();
        System.assertEquals(true, r.isSubscribed, 'email should win over contactId');
    }

    @isTest
    static void unknownEmailFailsClosed() {
        Test.startTest();
        ChessCoachCheckSubscription.Result r = run('nobody@example.com', null);
        Test.stopTest();
        System.assertEquals(false, r.isSubscribed, 'no matching Contact → fail closed');
    }

    @isTest
    static void blankInputFailsClosed() {
        Test.startTest();
        ChessCoachCheckSubscription.Result r = run('', '');
        Test.stopTest();
        System.assertEquals(false, r.isSubscribed, 'blank input → fail closed');
        System.assert(r.message.contains('subscription'), 'message: ' + r.message);
    }
}
