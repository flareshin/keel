package shopadmin.user;

import java.util.List;

public class UserService {
    private final UserRepository userRepository;

    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    public List<User> getUserList() {
        return userRepository.findAll().stream()
                .filter(User::active)
                .toList();
    }
}
