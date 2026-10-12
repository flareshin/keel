package shopadmin.user;

import java.util.List;

public class UserController {
    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    public List<User> listUsers() {
        return userService.getUserList();
    }
}
