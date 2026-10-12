package shopadmin.user;

import java.util.stream.Collectors;

public class UserExportJob {
    private final UserService userService;

    public UserExportJob(UserService userService) {
        this.userService = userService;
    }

    public String buildCsv() {
        return userService.getUserList().stream()
                .map(user -> user.id() + "," + user.email())
                .collect(Collectors.joining("\n"));
    }
}
