import SwiftUI

struct SignInView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        CardBox {
            Text("Sign in to Called It").font(.largeTitle.bold())
            Text("Verify your phone number in the Called It app. Your sign-in is shared securely with this Messages extension.")
            PrimaryButton(title: "Sign in with phone number") { model.openHost() }
                .accessibilityIdentifier("openPhoneSignIn")
            Text("After signing in, return to Messages and reopen this card. Called It reads no chats or contacts.")
                .font(.footnote).foregroundStyle(Theme.sub)
            ErrorText(text: model.error)
        }
    }
}
