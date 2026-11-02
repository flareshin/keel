package desk.users;

public record User(String id, String email, String phone, boolean emailAlerts, boolean smsAlerts, String digestFrequency) {}
