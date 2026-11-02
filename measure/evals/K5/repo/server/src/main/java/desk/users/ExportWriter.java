package desk.users;

import java.io.IOException;

public interface ExportWriter {
    void write(User user) throws IOException;
}
