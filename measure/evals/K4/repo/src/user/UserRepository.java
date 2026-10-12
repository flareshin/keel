package shopadmin.user;

import java.util.List;

public interface UserRepository {
    List<User> findAll();
}
