package desk.users;

import java.util.HashMap;
import java.util.Map;
import java.util.NoSuchElementException;

public class UserService {
    private final UserRepository users;

    public UserService(UserRepository users) {
        this.users = users;
    }

    public Map<String, Object> contact(String userId) {
        User user = users.findById(userId).orElseThrow(NoSuchElementException::new);
        Map<String, Object> contact = new HashMap<>();
        contact.put("email", user.email());
        contact.put("phone", user.phone());
        return contact;
    }
}
