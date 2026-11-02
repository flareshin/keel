package desk.users;

import java.io.IOException;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class UserExportJob {
    private static final Logger log = LoggerFactory.getLogger(UserExportJob.class);

    private final UserRepository users;
    private final ExportWriter writer;

    public UserExportJob(UserRepository users, ExportWriter writer) {
        this.users = users;
        this.writer = writer;
    }

    public void run() throws IOException {
        List<User> all = users.findAll();
        for (User user : all) {
            writer.write(user);
        }
        log.info("exported {} users", all.size());
    }
}
